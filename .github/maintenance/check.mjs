#!/usr/bin/env node
// Deterministic upstream detection for the daily compatibility schedule.
//   check   compare live upstream facts with baseline.json, write candidate.json, print a verdict
//   accept  promote candidate.json to baseline.json after the run has reviewed every change
// Verdicts: NO_CHANGE, PENDING_FOLLOWUP, REVIEW, ERROR. A failed source is ERROR, never NO_CHANGE.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STATE_DIR = process.env.PASEO_MAINTENANCE_STATE_DIR ?? path.join(REPO_DIR, '.scratch/upstream-compat-watch');
const BASELINE = path.join(STATE_DIR, 'baseline.json');
const CANDIDATE = path.join(STATE_DIR, 'candidate.json');

const GITHUB_REPOS = ['getpaseo/paseo', 'deepseek-ai/deepseek-harness'];
const NPM_PACKAGES = [
  '@getpaseo/plugin',
  '@getpaseo/client',
  '@getpaseo/protocol',
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-acp',
];
// The maintained registry records and their independent release tag prefixes.
const REGISTRY_PLUGINS = {
  'geoqiao/agent-activity': { dir: 'plugins/agent-activity', tag: 'readable-agent-activity-v' },
  'geoqiao/deepseek-harness': { dir: 'plugins/deepseek-harness', tag: 'deepseek-harness-v' },
  'geoqiao/math-renderer': { dir: 'plugins/math-renderer', tag: 'math-renderer-v' },
};
const REPO = 'geoqiao/paseo-stuff';
const CLOSED_PENDING = /^(resolved|dropped|done|closed)/;

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

async function withRetry(fn) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

function githubReleases(repo) {
  const releases = JSON.parse(run('gh', ['api', `repos/${repo}/releases?per_page=30`]));
  const tagShas = {};
  for (const line of run('git', ['ls-remote', '--tags', `https://github.com/${repo}.git`]).split('\n')) {
    const [sha, ref] = line.split('\t');
    if (!ref) continue;
    const peeled = ref.endsWith('^{}');
    const tag = ref.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, '');
    if (peeled || !tagShas[tag]) tagShas[tag] = sha;
  }
  const entries = {};
  for (const release of releases) {
    if (release.draft) continue;
    entries[release.id] = {
      tag: release.tag_name,
      commit: tagShas[release.tag_name] ?? null,
      prerelease: release.prerelease,
      publishedAt: release.published_at,
      bodyHash: hash(release.body ?? ''),
      assets: release.assets.map((asset) => [asset.name, asset.size, asset.updated_at]),
    };
  }
  return entries;
}

async function npmPackage(name) {
  const doc = await fetchJson(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, {
    Accept: 'application/vnd.npm.install-v1+json',
  });
  const versions = {};
  for (const [version, meta] of Object.entries(doc.versions ?? {})) {
    versions[version] = meta.dist?.integrity ?? null;
  }
  return { distTags: doc['dist-tags'] ?? {}, versions };
}

function diffMaps(before = {}, after = {}) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [key, value] of Object.entries(after)) {
    if (!(key in before)) added.push(key);
    else if (JSON.stringify(before[key]) !== JSON.stringify(value)) changed.push(key);
  }
  for (const key of Object.keys(before)) if (!(key in after)) removed.push(key);
  return { added, changed, removed };
}

async function collect() {
  const snapshot = { checkedAt: new Date().toISOString(), github: {}, npm: {} };
  const errors = [];
  for (const repo of GITHUB_REPOS) {
    try {
      snapshot.github[repo] = await withRetry(async () => githubReleases(repo));
    } catch (error) {
      errors.push(`github ${repo}: ${error.message.split('\n')[0]}`);
    }
  }
  await Promise.all(
    NPM_PACKAGES.map(async (name) => {
      try {
        snapshot.npm[name] = await withRetry(() => npmPackage(name));
      } catch (error) {
        errors.push(`npm ${name}: ${error.message}`);
      }
    }),
  );
  return { snapshot, errors };
}

export function compare(baseline, snapshot) {
  const changes = [];
  for (const [repo, releases] of Object.entries(snapshot.github ?? {})) {
    const d = diffMaps(baseline.github?.[repo], releases);
    for (const id of d.added) changes.push({ source: repo, kind: 'release_added', ...releases[id], id });
    for (const id of d.changed) changes.push({ source: repo, kind: 'release_changed', ...releases[id], id });
    // Releases that only scrolled off the first page are not removals; report those still in range.
    const oldest = Math.min(...Object.values(releases).map((r) => Date.parse(r.publishedAt)));
    for (const id of d.removed) {
      const old = baseline.github[repo][id];
      if (Date.parse(old.publishedAt) >= oldest) changes.push({ source: repo, kind: 'release_removed', tag: old.tag, id });
    }
  }
  for (const [name, pkg] of Object.entries(snapshot.npm ?? {})) {
    const before = baseline.npm?.[name] ?? { distTags: {}, versions: {} };
    const tags = diffMaps(before.distTags, pkg.distTags);
    for (const tag of [...tags.added, ...tags.changed, ...tags.removed]) {
      changes.push({ source: name, kind: 'dist_tag', tag, from: before.distTags[tag] ?? null, to: pkg.distTags[tag] ?? null });
    }
    const versions = diffMaps(before.versions, pkg.versions);
    for (const version of versions.added) changes.push({ source: name, kind: 'version_added', version, integrity: pkg.versions[version] });
    for (const version of versions.changed) changes.push({ source: name, kind: 'version_integrity_changed', version });
    for (const version of versions.removed) changes.push({ source: name, kind: 'version_removed', version });
  }
  return changes;
}

async function followups() {
  const pending = [];
  const errors = [];
  let tracked = [];
  try {
    const state = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'state.json'), 'utf8'));
    tracked = state.trackedUpstream ?? [];
    for (const item of state.pending ?? []) {
      if (!CLOSED_PENDING.test(item.status ?? '')) {
        pending.push({ kind: 'state_pending', id: item.id, status: item.status, resumeWhen: item.resumeWhen ?? null, due: item.reviewAfter ? Date.parse(item.reviewAfter) <= Date.now() : false });
        for (const url of [item.pullRequest, item.upstreamIssue]) {
          if (url && !url.startsWith(`https://github.com/${REPO}/`)) tracked.push(url);
        }
      }
    }
  } catch (error) {
    errors.push(`state.json: ${error.message}`);
  }
  const gh = (args) => JSON.parse(run('gh', args));
  const sources = [
    ['open PRs ' + REPO, () => {
      const prs = gh(['pr', 'list', '-R', REPO, '--state', 'open', '--limit', '1000', '--json', 'number,title,url,isCrossRepository']);
      if (prs.length === 1000) throw new Error('PR list reached its limit; narrow or paginate before accepting');
      for (const pr of prs) {
        const detail = gh(['pr', 'view', String(pr.number), '-R', REPO, '--json', 'headRefOid,updatedAt,comments,reviews,reviewDecision,statusCheckRollup']);
        pending.push({ kind: 'open_pr', repo: REPO, number: pr.number, title: pr.title, url: pr.url, external: pr.isCrossRepository, ...summarizeActivity(detail) });
      }
    }],
    ['open issues ' + REPO, () => {
      const issues = gh(['issue', 'list', '-R', REPO, '--state', 'open', '--limit', '1000', '--json', 'number,title,url,labels,body,comments,updatedAt']);
      if (issues.length === 1000) throw new Error('Issue list reached its limit; narrow or paginate before accepting');
      for (const issue of issues) {
        pending.push({ kind: 'open_issue', number: issue.number, title: issue.title, url: issue.url, labels: issue.labels.map((label) => label.name), ...summarizeActivity(issue) });
      }
    }],
    ['CI approvals ' + REPO, () => {
      const runs = gh(['api', `repos/${REPO}/actions/runs?status=action_required&per_page=20`]).workflow_runs ?? [];
      for (const r of runs) pending.push({ kind: 'ci_approval_needed', branch: r.head_branch, url: r.html_url });
    }],
    ['registry PRs', () => {
      const prs = gh(['pr', 'list', '-R', 'getpaseo/plugins', '--state', 'open', '--limit', '1000', '--search', 'geoqiao', '--json', 'number,title,url,updatedAt,headRefOid,comments,reviews,statusCheckRollup']);
      for (const pr of prs) pending.push({ kind: 'registry_pr', number: pr.number, title: pr.title, url: pr.url, ...summarizeActivity(pr) });
    }],
  ];
  for (const [name, fn] of sources) {
    try {
      fn();
    } catch (error) {
      errors.push(`${name}: ${error.message.split('\n')[0]}`);
    }
  }
  for (const url of [...new Set(tracked)]) {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)$/.exec(url);
    if (!match) { errors.push(`Invalid tracked upstream URL: ${url}`); continue; }
    const [, repo, type, number] = match;
    try {
      const fields = type === 'pull'
        ? 'number,title,state,updatedAt,headRefOid,comments,reviews,reviewDecision,statusCheckRollup,mergedAt,mergeCommit'
        : 'number,title,state,updatedAt,body,comments,closedAt';
      const detail = gh([type === 'pull' ? 'pr' : 'issue', 'view', number, '-R', repo, '--json', fields]);
      pending.push({ kind: 'tracked_upstream', repo, number: Number(number), url, title: detail.title, state: detail.state, mergedAt: detail.mergedAt ?? null, mergeCommit: detail.mergeCommit?.oid ?? null, ...summarizeActivity(detail) });
    } catch (error) { errors.push(`tracked ${url}: ${error.message.split('\n')[0]}`); }
  }
  let releases = [];
  try {
    releases = gh(['release', 'list', '-R', REPO, '--limit', '100', '--json', 'tagName,publishedAt,isDraft']);
  } catch (error) {
    errors.push(`releases ${REPO}: ${error.message.split('\n')[0]}`);
  }
  await Promise.all(
    Object.entries(REGISTRY_PLUGINS).map(async ([id, { dir, tag }]) => {
      try {
        const record = await withRetry(() => fetchJson(`https://raw.githubusercontent.com/getpaseo/plugins/main/plugins/${id}.json`));
        const artifact = record.artifact ?? {};
        let pinned;
        if (artifact.kind === 'npm') pinned = artifact.version;
        else {
          run('git', ['-C', REPO_DIR, 'fetch', '--quiet', 'origin', artifact.commit]);
          pinned = JSON.parse(run('git', ['-C', REPO_DIR, 'show', `${artifact.commit}:${dir}/package.json`])).version;
        }
        const latest = releases
          .filter((r) => !r.isDraft && r.tagName.startsWith(tag))
          .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0];
        const released = latest?.tagName.slice(tag.length) ?? null;
        if (released && pinned !== released) {
          pending.push({ kind: 'registry_behind', id, artifact: artifact.kind, pinned, released });
        }
      } catch (error) {
        errors.push(`registry ${id}: ${error.message.split('\n')[0]}`);
      }
    }),
  );
  return { pending, errors };
}

export function summarizeActivity(detail) {
  const comments = detail.comments ?? [];
  const last = comments.at(-1);
  return {
    updatedAt: detail.updatedAt ?? null,
    head: detail.headRefOid ?? null,
    lastComment: last ? { author: last.author?.login, createdAt: last.createdAt, url: last.url } : null,
    fingerprint: hash({ body: detail.body, comments, reviews: detail.reviews, checks: detail.statusCheckRollup, decision: detail.reviewDecision, head: detail.headRefOid }),
  };
}

export function followupChanges(before = [], after = []) {
  const key = (item) => item.url ?? `${item.kind}:${item.id ?? item.number ?? item.branch}`;
  const old = new Map(before.map((item) => [key(item), item]));
  const current = new Map(after.map((item) => [key(item), item]));
  const changes = [];
  for (const [id, item] of current) {
    if (JSON.stringify(old.get(id)) !== JSON.stringify(item)) changes.push({ kind: 'followup_changed', item });
  }
  for (const [id, item] of old) if (!current.has(id)) changes.push({ kind: 'followup_closed', item });
  return changes;
}

export function verdictFor(baseline, changes, followChanges, errors) {
  if (errors.length) return 'ERROR';
  if (!baseline || changes.length) return 'REVIEW';
  if (followChanges.length) return 'PENDING_FOLLOWUP';
  return 'NO_CHANGE';
}

async function check() {
  const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
  const { snapshot, errors } = await collect();
  const follow = await followups();
  errors.push(...follow.errors);
  const changes = baseline ? compare(baseline, snapshot) : [];
  const followChanges = followupChanges(baseline?.followups, follow.pending);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const temporary = `${CANDIDATE}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ ...snapshot, followups: follow.pending, errors }, null, 2)}\n`);
  fs.renameSync(temporary, CANDIDATE);
  const verdict = verdictFor(baseline, changes, followChanges, errors);
  return {
    verdict,
    baselineCheckedAt: baseline?.checkedAt ?? null,
    checkedAt: snapshot.checkedAt,
    ...(baseline ? {} : { note: 'No baseline.json; review current upstream state, then accept.' }),
    changes,
    pending: follow.pending,
    followupChanges: followChanges,
    errors,
  };
}

function accept() {
  const candidate = JSON.parse(fs.readFileSync(CANDIDATE, 'utf8'));
  if (candidate.errors?.length) throw new Error('candidate.json has source errors; rerun check before accepting');
  const { errors, ...snapshot } = candidate;
  const temporary = `${BASELINE}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
  fs.renameSync(temporary, BASELINE);
  return { accepted: true, checkedAt: snapshot.checkedAt };
}

const command = process.argv[2];
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && command === 'check') {
  const result = await check();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.verdict === 'ERROR' ? 1 : 0;
} else if (isMain && command === 'accept') {
  console.log(JSON.stringify(accept()));
} else if (isMain) {
  console.error('Usage: node .github/maintenance/check.mjs check|accept');
  process.exitCode = 64;
}
