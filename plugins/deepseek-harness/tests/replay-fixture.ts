import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

/** Synthetic append-only compaction history; originals stay in the log. */
export function appendCompactionFixture(rows: Record<string, any>[], id = "compact-1"): void {
  const add = (type: string, data: unknown, surfaceOp?: unknown) => {
    const seq = rows.length - 1;
    rows.push({ type, seq, time: 1793232000000 + seq, data, ...(surfaceOp ? { surfaceOp } : {}) });
  };
  add("compaction/prune", { shadowedRange: { start: 4, end: 4 }, shadowedSeqs: [4], shadowedTokenCount: 42 });
  add("tool/result", { message: { ...rows[5].data.message, content: [{ type: "text", text: "PRUNED-OUTPUT" }] } },
    { op: "replace", startSeq: 4, endSeq: 4 });
  add("compaction/start", { compactionId: id, turn: 1 });
  add("compaction/summary", {
    compactionId: id, shadowedRange: { start: 1, end: 5 }, shadowedSeqs: [1, 2, rows.length - 3, 5],
    summary: [{ type: "text", text: "INTERNAL-SUMMARY" }], shadowedTokenCount: 100,
  });
  add("user/message", {
    id: id + "-checkpoint", role: "user", source: { kind: "compact-checkpoint", compactionId: id },
    content: [{ type: "text", text: "INTERNAL-CHECKPOINT" }],
  }, { op: "replace", startSeq: 1, endSeq: 5 });
  add("compaction/end", { compactionId: id, turn: 1 });
  add("web/deepseek-search-llm-request", { body: { messages: [{ content: "INTERNAL-SEARCH-REQUEST" }] } });
}

/** Authored synthetic JSONL, compressed into several independent flush frames. */
export async function writeReplayFixture(
  home: string,
  sessionId = "synthetic-session",
  cwd = "/synthetic/workspace",
  edit: (rows: Record<string, any>[]) => void = () => undefined,
): Promise<string> {
  const text = await readFile(new URL("./fixtures/session-v4.jsonl", import.meta.url), "utf8");
  const rows = text.trim().split("\n").map((line) => JSON.parse(line));
  rows[0].id = sessionId;
  rows[0].cwd = cwd;
  edit(rows);
  const batches: Buffer[] = [];
  for (let index = 0; index < rows.length; index += 2) {
    batches.push(zstdCompressSync(Buffer.from(rows.slice(index, index + 2).map((row) => JSON.stringify(row) + "\n").join(""))));
  }
  const directory = join(home, "sessions", "synthetic-project", sessionId);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "session.v4.jsonl.zstd");
  await writeFile(path, Buffer.concat(batches));
  return path;
}
