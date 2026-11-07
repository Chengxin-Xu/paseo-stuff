#!/usr/bin/env node
// Local schedule coordination. No expiry or forced release. A lock is taken over only
// when Paseo reports its holder agent as archived: a schedule run ends with its agent.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const [command, ...args] = process.argv.slice(2);
const flags = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith('--') || !args[i + 1] || flags.has(args[i])) {
    throw new Error('Expected unique --key value arguments');
  }
  flags.set(args[i], args[i + 1]);
}
const allowed = new Set(['--state-dir', '--agent-id', '--run-id', '--schedule-id', '--owner-pid', '--token']);
for (const flag of flags.keys()) if (!allowed.has(flag)) throw new Error(`Unknown flag: ${flag}`);
const stateDir = flags.get('--state-dir') ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.scratch/upstream-compat-watch');
if (!path.isAbsolute(stateDir)) throw new Error('state-dir must be absolute');
const lockDir = path.join(stateDir, 'run.lock');
const ownerFile = path.join(lockDir, 'owner.json');
const required = (name) => {
  const value = flags.get(name);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
};
function inspect() {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    // The token is a release guard, not a secret. Preserve it only in owner.json.
    const { token, ...publicOwner } = owner;
    return { locked: true, owner: publicOwner };
  } catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(lockDir)) return { locked: false };
    return { locked: true, uncertain: true, error: 'Owner metadata missing or unreadable; do not take over.' };
  }
}
// True only when Paseo returns the holder agent and reports it archived. Any error,
// missing agent or unexpected output counts as possibly running.
function holderArchived(agentId) {
  try {
    const out = execFileSync('paseo', ['inspect', agentId, '--json'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const agent = JSON.parse(out);
    return agent.Id === agentId && agent.Archived === true;
  } catch {
    return false;
  }
}
function takeOverArchived() {
  const current = inspect();
  if (current.uncertain || !current.owner?.agentId || !holderArchived(current.owner.agentId)) return null;
  // rename is atomic: of two concurrent acquirers, only one moves the stale lock away.
  const stale = `${lockDir}.stale-${Date.now()}-${process.pid}`;
  try { fs.renameSync(lockDir, stale); } catch { return null; }
  fs.rmSync(stale, { recursive: true, force: true });
  return current.owner;
}
function main() {
  if (command === 'status') return inspect();
  if (command === 'acquire') {
    const agentId = required('--agent-id');
    const runId = required('--run-id');
    const ownerPidText = flags.get('--owner-pid');
    const ownerPid = ownerPidText === undefined ? null : Number(ownerPidText);
    if (ownerPid !== null && (!Number.isSafeInteger(ownerPid) || ownerPid <= 0)) {
      throw new Error('owner-pid must be a positive integer');
    }
    fs.mkdirSync(stateDir, { recursive: true });
    let tookOverFrom = null;
    try { fs.mkdirSync(lockDir, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      tookOverFrom = takeOverArchived();
      try { if (tookOverFrom) fs.mkdirSync(lockDir, { mode: 0o700 }); }
      catch (retryError) { if (retryError.code !== 'EEXIST') throw retryError; tookOverFrom = null; }
      if (!tookOverFrom) {
        process.exitCode = 2;
        return { acquired: false, ...inspect() };
      }
    }
    const owner = {
      schemaVersion: 1,
      scheduleId: flags.get('--schedule-id') ?? null,
      runId,
      agentId,
      ownerPid,
      acquisitionHelperPid: process.pid,
      acquiredAt: new Date().toISOString(),
      token: randomUUID(),
      ...(tookOverFrom ? { tookOverFrom } : {}),
    };
    // An interrupted metadata write leaves a locked/uncertain directory, never an unlocked writer.
    fs.writeFileSync(ownerFile, JSON.stringify(owner, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { acquired: true, ...owner };
  }
  if (command === 'release') {
    const agentId = required('--agent-id');
    const token = required('--token');
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    if (owner.agentId !== agentId || owner.token !== token) throw new Error('Lock ownership mismatch');
    // The caller must first verify that all owned writers/delegates have finished.
    fs.unlinkSync(ownerFile);
    fs.rmdirSync(lockDir);
    return { released: true, agentId, runId: owner.runId };
  }
  throw new Error('Usage: lock.mjs status | acquire --agent-id ID --run-id ID [--owner-pid PID] | release --agent-id ID --token TOKEN');
}
try { console.log(JSON.stringify(main())); }
catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
