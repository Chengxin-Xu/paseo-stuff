import { open, opendir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { zstdDecompress } from "node:zlib";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { resolveDshHome } from "./dsh-home";

const SESSION_FILE = "session.v4.jsonl.zstd";
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 50_000;
const MAX_PROJECTS = 1_024;
const MAX_REPLAY_MS = 1_000;

// Known v4 bookkeeping, not transcript messages. Unknown event kinds fail the
// entire replay rather than displaying a possibly misleading partial history.
const BOOKKEEPING = new Set([
  "turn/start", "turn/end", "step/start", "step/end", "assistant/attempt",
  "request/header", "request/context", "session/end-seed", "session/title",
  "permission/preset", "sandbox/mode", "approval/policy", "agent/inbox/spliced",
  "session-log-deepseek/delivery-accepted", "job/registered", "job/settled",
  "goal/change", "system/message", "developer/message", "model/selection",
  "compaction/start", "compaction/summary", "compaction/end", "compaction/prune",
  "web/deepseek-search-llm-request",
]);

export interface ReplayTarget {
  sessionId: string;
  cwd: string;
}

export type ReplayFailureReason = "missing" | "corrupt" | "unsupported" | "limit" | "unavailable";

export interface SessionReplay {
  frames: AcpStreamMessage[];
  failure?: ReplayFailureReason;
}

class ReplayError extends Error {
  constructor(readonly reason: ReplayFailureReason) {
    super("Session replay unavailable");
  }
}

type RecordValue = Record<string, unknown>;

/** Best-effort v4 text history only; no writes, new sessions, or model calls. */
export async function buildSessionReplay(
  target: ReplayTarget,
  env: Readonly<Record<string, string | undefined>>,
): Promise<SessionReplay> {
  const signal = AbortSignal.timeout(MAX_REPLAY_MS);
  try {
    return { frames: await Promise.race([
      readReplay(target, resolveDshHome(env.DSH_HOME), signal),
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]) };
  } catch (error) {
    // Only classified reasons cross the bridge. Never expose paths, transcript
    // contents or raw errors, and never turn a successful resume into a failure.
    const code = (error as NodeJS.ErrnoException)?.code;
    const failure = signal.aborted || code === "ERR_BUFFER_TOO_LARGE" ? "limit"
      : error instanceof ReplayError ? error.reason
      : code === "ENOENT" ? "missing"
      : error instanceof SyntaxError || code?.startsWith("ZSTD_") ? "corrupt"
      : "unavailable";
    return { frames: [], failure };
  }
}

async function readReplay(
  target: ReplayTarget,
  home: string,
  signal: AbortSignal,
): Promise<AcpStreamMessage[]> {
  // DSH currently issues UUIDs. Refuse other path syntax rather than allowing
  // a session/load parameter to escape the sessions directory.
  if (!/^[A-Za-z0-9_-]+$/.test(target.sessionId)) throw new ReplayError("unsupported");
  const root = join(home, "sessions");
  const projects = await opendir(root);
  let count = 0;
  let unsupported = false;
  for await (const project of projects) {
    signal.throwIfAborted();
    if (++count > MAX_PROJECTS) throw new ReplayError("limit");
    if (!project.isDirectory()) continue;
    const directory = join(root, project.name, target.sessionId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    // A migrated session can retain older generations. Never replay stale v4
    // data when a newer generation exists beside it.
    if (names.some((name) => {
      const match = /^session\.v([1-9]\d*)\.jsonl(?:\.zstd)?$/.exec(name);
      return match !== null && Number(match[1]) > 4;
    })) throw new ReplayError("unsupported");
    if (!names.includes(SESSION_FILE)) {
      if (names.some((name) => /^session\.v[1-9]\d*\.jsonl(?:\.zstd)?$/.test(name))) {
        unsupported = true;
      }
      continue;
    }
    const compressed = await readBounded(join(directory, SESSION_FILE), signal);
    const text = await decodeFrames(compressed, signal);
    const lines = text.split("\n");
    if (lines.pop() !== "") throw new ReplayError("corrupt");
    if (lines.length > MAX_RECORDS) throw new ReplayError("limit");
    const header = record(JSON.parse(lines[0]));
    if (header.type !== "session") throw new ReplayError("corrupt");
    if (header.version !== 4) throw new ReplayError("unsupported");
    if (header.id !== target.sessionId || header.cwd !== target.cwd) continue;
    const frames: AcpStreamMessage[] = [];
    let previous: RecordValue | undefined;
    for (let index = 1; index < lines.length; index++) {
      if (index % 256 === 0) await yieldLoop();
      signal.throwIfAborted();
      const event = record(JSON.parse(lines[index]));
      if (event.seq !== index - 1 || typeof event.time !== "number") {
        throw new ReplayError("corrupt");
      }
      for (const update of replayEvent(event, previous)) {
        frames.push({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: target.sessionId, update },
        });
        if (frames.length > MAX_RECORDS) throw new ReplayError("limit");
      }
      previous = event;
    }
    return frames;
  }
  throw new ReplayError(unsupported ? "unsupported" : "missing");
}

async function readBounded(path: string, signal: AbortSignal): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new ReplayError("unavailable");
    if (before.size > MAX_FILE_BYTES) throw new ReplayError("limit");
    // A fixed buffer also bounds memory if the file grows after stat().
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new ReplayError("corrupt");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new ReplayError("corrupt");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function decodeFrames(input: Buffer, signal: AbortSignal): Promise<string> {
  const parts: Buffer[] = [];
  let offset = 0;
  let bytes = 0;
  while (offset < input.length) {
    signal.throwIfAborted();
    if (parts.length >= MAX_RECORDS || bytes >= MAX_TEXT_BYTES) throw new ReplayError("limit");
    const remaining = input.subarray(offset);
    if (remaining.length < 4 || remaining.readUInt32LE(0) !== 0xfd2fb528) {
      throw new ReplayError("corrupt");
    }
    const length = frameLength(remaining);
    // DSH appends independent frames. Walk their headers instead of searching
    // payloads for magic bytes, which can also occur inside a valid frame.
    const decoded = await new Promise<Buffer>((resolve, reject) => {
      zstdDecompress(remaining.subarray(0, length), { maxOutputLength: MAX_TEXT_BYTES - bytes }, (error, result) => {
        if (error) reject(new ReplayError((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? "limit" : "corrupt"));
        else resolve(result);
      });
    });
    signal.throwIfAborted();
    parts.push(decoded);
    bytes += decoded.length;
    offset += length;
  }
  return Buffer.concat(parts, bytes).toString("utf8");
}

/** RFC 8878 framing: require every block and optional checksum before decoding.
 * Node can return decoded bytes for a truncated last frame without an error. */
function frameLength(input: Buffer): number {
  if (input.length < 5) throw new ReplayError("corrupt");
  const flags = input[4];
  if (flags & 0x18) throw new ReplayError("corrupt");
  const singleSegment = (flags & 0x20) !== 0;
  const contentSizeFlag = flags >>> 6;
  const dictionaryBytes = [0, 1, 2, 4][flags & 3];
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 2 ** contentSizeFlag;
  let end = 5 + (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  for (;;) {
    if (end + 3 > input.length) throw new ReplayError("corrupt");
    const block = input.readUIntLE(end, 3);
    const kind = (block >>> 1) & 3;
    const size = block >>> 3;
    if (kind === 3 || size > 128 * 1024) throw new ReplayError("corrupt");
    end += 3 + (kind === 1 ? 1 : size);
    if (end > input.length) throw new ReplayError("corrupt");
    if (block & 1) break;
  }
  if (flags & 4) end += 4;
  if (end > input.length) throw new ReplayError("corrupt");
  return end;
}

function replayEvent(event: RecordValue, previous?: RecordValue): RecordValue[] {
  const data = record(event.data);
  if (typeof event.type !== "string") throw new ReplayError("corrupt");
  if (BOOKKEEPING.has(event.type)) return [];
  // Display the append-only conversation, not the model's compacted surface.
  // DSH retains originals and appends a marker immediately before each prune
  // or checkpoint replacement. Do not duplicate those as fresh chat messages.
  if (event.surfaceOp !== undefined && event.surfaceOp !== "append") {
    if (isCompactionReplacement(event, previous)) return [];
    throw new ReplayError("unsupported");
  }
  switch (event.type) {
    case "user/message": {
      const source = record(data.source);
      if (typeof source.kind !== "string") throw new ReplayError("corrupt");
      if (source.kind !== "user") return [];
      return textUpdates(data, "user_message_chunk");
    }
    case "assistant/message":
      return textUpdates(record(data.message), "agent_message_chunk");
    case "tool/call": {
      const args = string(data.arguments);
      let rawInput: unknown = args;
      try { rawInput = JSON.parse(args); } catch { /* Preserve invalid tool JSON as text. */ }
      return [{
        sessionUpdate: "tool_call", toolCallId: string(data.callId),
        title: string(data.name), kind: "other", status: "in_progress", rawInput,
      }];
    }
    case "tool/result": {
      const message = record(data.message);
      const content = blocks(message.content).map((block) => {
        if (block.type !== "text") throw new ReplayError("unsupported");
        return { type: "content", content: { type: "text", text: string(block.text) } };
      });
      if (message.isError !== undefined && typeof message.isError !== "boolean") {
        throw new ReplayError("corrupt");
      }
      return [{
        sessionUpdate: "tool_call_update", toolCallId: string(message.toolCallId),
        status: message.isError ? "failed" : "completed", content, rawOutput: { content },
      }];
    }
    default:
      throw new ReplayError("unsupported");
  }
}

/** Recognise only the correlated v4 rewrites emitted by DSH compaction. */
function isCompactionReplacement(event: RecordValue, previous?: RecordValue): boolean {
  if (!previous || typeof event.surfaceOp !== "object" || event.surfaceOp === null
    || Array.isArray(event.surfaceOp)) return false;
  const op = event.surfaceOp as RecordValue;
  if (op.op !== "replace" || !Number.isSafeInteger(op.startSeq) || !Number.isSafeInteger(op.endSeq)) return false;
  const start = op.startSeq as number;
  const end = op.endSeq as number;
  // Replacement endpoints follow surface position, not numeric log order.
  if (start < 0 || end < 0 || start >= (previous.seq as number) || end >= (previous.seq as number)) return false;
  const marker = record(previous.data);
  if (previous.type !== "compaction/prune" && previous.type !== "compaction/summary") return false;
  const range = record(marker.shadowedRange);
  if (range.start !== start || range.end !== end) return false;
  const data = record(event.data);
  if (previous.type === "compaction/prune") {
    return event.type === "tool/result" && start === end
      && Array.isArray(marker.shadowedSeqs) && marker.shadowedSeqs.length === 1
      && marker.shadowedSeqs[0] === start;
  }
  if (event.type !== "user/message") return false;
  const source = record(data.source);
  return source.kind === "compact-checkpoint" && typeof marker.compactionId === "string"
    && source.compactionId === marker.compactionId;
}

function textUpdates(message: RecordValue, kind: string): RecordValue[] {
  const id = string(message.id);
  return blocks(message.content).flatMap((block, index) => {
    // The separate tool/call record owns this card.
    if (block.type === "tool-call" && kind === "agent_message_chunk") return [];
    const thought = block.type === "reasoning" && kind === "agent_message_chunk";
    if (block.type !== "text" && !thought) throw new ReplayError("unsupported");
    return [{
      sessionUpdate: thought ? "agent_thought_chunk" : kind,
      messageId: `replay:${id}:${index}`,
      content: { type: "text", text: string(block.text) },
    }];
  });
}

function record(value: unknown): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReplayError("corrupt");
  }
  return value as RecordValue;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new ReplayError("corrupt");
  return value;
}

function blocks(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) throw new ReplayError("corrupt");
  return value.map(record);
}
