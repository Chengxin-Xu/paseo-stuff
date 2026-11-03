import { appendFile, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendCompactionFixture, writeReplayFixture } from "../tests/replay-fixture";
import { resolveDshHome } from "./dsh-home";
import { buildSessionReplay } from "./session-replay";

let home: string;
const target = { sessionId: "synthetic-session", cwd: "/synthetic/workspace" };
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "dsh-replay-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

const result = () => buildSessionReplay(target, { DSH_HOME: home });
const replay = async () => (await result()).frames;

describe("DSH v4 transcript replay", () => {
  it("distinguishes a legitimately empty transcript from a missing log", async () => {
    expect(await result()).toEqual({ frames: [], failure: "missing" });
    await writeReplayFixture(home, undefined, undefined, (rows) => { rows.splice(1); });
    expect(await result()).toEqual({ frames: [] });
  });

  it.each(["missing", "corrupt", "unsupported", "limit", "unavailable"] as const)(
    "returns only frames and a safe classified reason for %s",
    async (reason) => {
      if (reason !== "missing") {
        const path = await writeReplayFixture(home, undefined, undefined, (rows) => {
          if (reason === "unsupported") rows[7].type = "private-future-event";
        });
        if (reason === "corrupt") await writeFile(path, "private transcript /private/path api_key=private-key");
        if (reason === "limit") {
          const handle = await open(path, "r+");
          try { await handle.truncate(16 * 1024 * 1024 + 1); }
          finally { await handle.close(); }
        }
        if (reason === "unavailable") {
          await rm(path);
          await import("node:fs/promises").then(({ mkdir }) => mkdir(path));
        }
      }
      expect(await result()).toEqual({ frames: [], failure: reason });
    },
  );

  it("replays all flush frames in order with separate thought and answer identities", async () => {
    await writeReplayFixture(home);
    const frames = await replay();
    const updates = frames.map((frame) => (frame as any).params.update);
    expect(updates.map((update) => update.sessionUpdate)).toEqual([
      "user_message_chunk", "agent_thought_chunk", "agent_message_chunk",
      "tool_call", "tool_call_update", "agent_message_chunk",
    ]);
    expect(updates[0].content.text).toBe("Read the synthetic note.");
    expect(updates[1].messageId).not.toBe(updates[2].messageId);
    expect(updates[3]).toMatchObject({ toolCallId: "tool-1", rawInput: { path: "note.txt" } });
    expect(updates[4]).toMatchObject({ toolCallId: "tool-1", status: "completed", rawOutput: { content: [{ content: { text: "Synthetic note: violet-4817." } }] } });
    expect(updates[5].content.text).toBe("The note says violet-4817.");
    expect(await result()).toEqual({ frames });
  });

  it("keeps tool failures and complete output, including its tail", async () => {
    await writeReplayFixture(home, undefined, undefined, (rows) => {
      rows[5].data.message.isError = true;
      rows[5].data.message.content[0].text = "x".repeat(20_000) + "tail-marker";
    });
    const frames = await replay();
    expect((frames[4] as any).params.update).toMatchObject({
      status: "failed", rawOutput: { content: [{ content: { text: "x".repeat(20_000) + "tail-marker" } }] },
    });
  });

  it("preserves original history through pruning and repeated compaction without modifying the log", async () => {
    await writeReplayFixture(home);
    const original = await replay();
    const path = await writeReplayFixture(home, undefined, undefined, (rows) => {
      appendCompactionFixture(rows);
      const seq = rows.length - 1;
      rows.push({ type: "user/message", seq, time: 0, surfaceOp: "append", data: {
        id: "after-compact", source: { kind: "user" }, content: [{ type: "text", text: "Continue after compaction." }],
      } });
      rows.push({ type: "assistant/message", seq: seq + 1, time: 0, surfaceOp: "append", data: { message: {
        id: "answer-after-compact", content: [{ type: "text", text: "Resumed answer." }],
      } } });
      const add = (type: string, data: unknown, surfaceOp?: unknown) => rows.push({
        type, seq: rows.length - 1, time: 0, data, ...(surfaceOp ? { surfaceOp } : {}),
      });
      // The second compaction replaces the previous checkpoint and the new turn.
      const range = { start: 11, end: seq + 1 };
      add("compaction/start", { compactionId: "compact-2", turn: 2 });
      add("compaction/summary", { compactionId: "compact-2", shadowedRange: range, shadowedSeqs: [11, seq, seq + 1] });
      add("user/message", { id: "checkpoint-2", source: { kind: "compact-checkpoint", compactionId: "compact-2" },
        content: [{ type: "text", text: "INTERNAL-SECOND-CHECKPOINT" }],
      }, { op: "replace", startSeq: range.start, endSeq: range.end });
      add("compaction/end", { compactionId: "compact-2", turn: 2 });
    });
    const before = await readFile(path);
    const frames = await replay();
    expect(frames.slice(0, original.length)).toEqual(original);
    expect(frames.slice(original.length).map((frame) => (frame as any).params.update.content.text))
      .toEqual(["Continue after compaction.", "Resumed answer."]);
    expect(await result()).toEqual({ frames });
    expect(await readFile(path)).toEqual(before);
  });

  it.each(["start", "summary", "end"])("keeps original history when a compaction stops after %s", async (phase) => {
    await writeReplayFixture(home);
    const original = await replay();
    await writeReplayFixture(home, undefined, undefined, (rows) => {
      appendCompactionFixture(rows);
      const end = rows.findIndex((row) => row.type === "compaction/" + phase);
      rows.splice(end + 1);
    });
    expect(await result()).toEqual({ frames: original });
  });

  it.each(["range", "id", "source", "kind", "operation", "forward-range", "negative-range", "prune-range", "prune-target", "intervening-event"])(
    "rejects an unrecognised compaction rewrite: %s", async (mode) => {
      await writeReplayFixture(home, undefined, undefined, (rows) => {
        appendCompactionFixture(rows);
        const checkpoint = rows.find((row) => row.data?.source?.kind === "compact-checkpoint")!;
        const prune = rows.find((row) => row.type === "compaction/prune")!;
        if (mode === "range") checkpoint.surfaceOp.endSeq = 4;
        if (mode === "id") checkpoint.data.source.compactionId = "other";
        if (mode === "source") checkpoint.data.source.kind = "user";
        if (mode === "kind") checkpoint.type = "assistant/message";
        if (mode === "operation") checkpoint.surfaceOp.op = "delete";
        if (mode === "forward-range") checkpoint.surfaceOp.endSeq = checkpoint.seq;
        if (mode === "negative-range") checkpoint.surfaceOp.startSeq = -1;
        if (mode === "prune-range") prune.data.shadowedRange.start = 3;
        if (mode === "prune-target") prune.data.shadowedSeqs = [3];
        if (mode === "intervening-event") {
          rows.splice(rows.indexOf(checkpoint), 0, { type: "step/start", data: {} });
          rows.slice(1).forEach((row, seq) => { row.seq = seq; row.time = 0; });
        }
      });
      expect((await result()).failure).toBe("unsupported");
    },
  );

  it.each([3, 5])("skips an unsupported header version %s", async (version) => {
    await writeReplayFixture(home, undefined, undefined, (rows) => { rows[0].version = version; });
    expect(await replay()).toEqual([]);
  });

  it("does not fall back to a stale v4 file after migration", async () => {
    const path = await writeReplayFixture(home);
    await writeFile(join(dirname(path), "session.v5.jsonl.zstd"), "new format");
    expect(await replay()).toEqual([]);
  });

  it("skips missing files, other filenames and mismatched session headers", async () => {
    expect(await replay()).toEqual([]);
    const path = await writeReplayFixture(home, undefined, "/other/workspace");
    expect(await replay()).toEqual([]);
    await rename(path, join(dirname(path), "session.v3.jsonl.zstd"));
    expect(await replay()).toEqual([]);
  });

  it.each(["unknown-event", "malformed-shape", "replacement", "sequence-gap", "unknown-block"])("discards the whole replay for %s", async (mode) => {
    await writeReplayFixture(home, undefined, undefined, (rows) => {
      if (mode === "unknown-event") rows[7].type = "future/event";
      if (mode === "malformed-shape") rows[6].data.message.content = null;
      if (mode === "replacement") rows[6].surfaceOp = { op: "replace", startSeq: 0, endSeq: 1 };
      if (mode === "sequence-gap") rows[7].seq = 100;
      if (mode === "unknown-block") rows[6].data.message.content[0].type = "future-block";
    });
    expect(await replay()).toEqual([]);
  });

  it.each(["truncated", "garbage", "invalid-json"])("does not replay a valid prefix followed by %s", async (mode) => {
    const path = await writeReplayFixture(home);
    if (mode === "truncated") {
      const bytes = await readFile(path);
      await writeFile(path, bytes.subarray(0, bytes.length - 1));
    } else {
      await appendFile(path, mode === "garbage" ? Buffer.from("garbage") : zstdCompressSync(Buffer.from("not json\n")));
    }
    expect(await replay()).toEqual([]);
  });

  it("rejects large files before reading and bounds decompressed output", async () => {
    const path = await writeReplayFixture(home);
    const handle = await open(path, "r+");
    await handle.truncate(16 * 1024 * 1024 + 1);
    await handle.close();
    expect(await result()).toEqual({ frames: [], failure: "limit" });
    await writeFile(path, zstdCompressSync(Buffer.alloc(64 * 1024 * 1024 + 1, 65)));
    expect(await result()).toEqual({ frames: [], failure: "limit" });
  });

  it("fails closed when its replay deadline has expired", async () => {
    await writeReplayFixture(home);
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    expect(await result()).toEqual({ frames: [], failure: "limit" });
  });

  it("bounds transcript event counts", async () => {
    const path = await writeReplayFixture(home);
    const rows = [JSON.stringify({ type: "session", version: 4, id: target.sessionId, cwd: target.cwd })];
    while (rows.length < 50_001) rows.push(JSON.stringify({ type: "turn/end", seq: rows.length - 1, time: 0, data: {} }));
    await writeFile(path, zstdCompressSync(Buffer.from(rows.join("\n") + "\n")));
    expect(await result()).toEqual({ frames: [], failure: "limit" });
  });

  it("does not use a session id as an arbitrary filesystem path", async () => {
    await writeReplayFixture(home);
    expect(await buildSessionReplay({ ...target, sessionId: "../synthetic-session" }, { DSH_HOME: home })).toEqual({ frames: [], failure: "unsupported" });
  });

  it("resolves DSH_HOME exactly like the usage source", () => {
    expect(resolveDshHome(undefined)).toBe(join(homedir(), ".dsh"));
    expect(resolveDshHome("  ")).toBe(join(homedir(), ".dsh"));
    expect(resolveDshHome(" ~ ")).toBe(homedir());
    expect(resolveDshHome(" ~/custom ")).toBe(join(homedir(), "custom"));
    expect(resolveDshHome(" ./custom ")).toBe(resolve("./custom"));
  });
});
