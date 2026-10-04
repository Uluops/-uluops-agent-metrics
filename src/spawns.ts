/**
 * Spawn manifest: the definition each subagent was spawned with (checklist X4-1).
 *
 * SubagentStart records, keyed by `agent_id`, the definition Claude Code loaded for the
 * subagent (it loads the full definition at spawn); SubagentStop reads the record back
 * and confirms the file is unchanged (`confirmAtStop`). Both events carry `agent_id`, so
 * the join needs no undocumented field.
 *
 * One JSON line per spawn, beside the metrics buffer. Lines older than
 * {@link SPAWN_TTL_MS} are dropped whenever the file passes {@link SPAWN_PRUNE_BYTES},
 * so the manifest cannot grow without bound. Writes go through the buffer's lock; a
 * failure to record a spawn is not fatal — the stop hook falls back to a stop-time
 * capture, marked `captured_at: 'stop'`, and the miss is counted.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireLock, releaseLock } from './lock.js';
import type { DefinitionCapture, UnresolvedCause } from './definition.js';

export const SPAWN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SPAWN_PRUNE_BYTES = 1024 * 1024;

export interface SpawnRecord {
  agent_id: string;
  agent_type: string | null;
  spawned_at_ms: number;
  definition: DefinitionCapture | null;
  unresolved: UnresolvedCause | null;
}

export function defaultSpawnPath(): string {
  return path.join(os.homedir(), '.claude', 'agent-metrics-spawns.jsonl');
}

function prune(file: string, nowMs: number): void {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return; }
  if (stat.size < SPAWN_PRUNE_BYTES) return;
  const keep = fs.readFileSync(file, 'utf8').split('\n').filter(line => {
    try { return nowMs - (JSON.parse(line) as SpawnRecord).spawned_at_ms < SPAWN_TTL_MS; } catch { return false; }
  });
  // Temp file + rename: findSpawn reads without the lock, and a truncate-then-write would
  // let a concurrent stop read an empty manifest and fall back to a stop-time capture.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, keep.length ? keep.join('\n') + '\n' : '', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Append a spawn record. Returns false when the lock could not be taken (the caller counts it). */
export function recordSpawn(record: SpawnRecord, file: string = defaultSpawnPath(), lockTimeoutMs = 5000): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockPath = file + '.lock';
  if (!acquireLock(lockPath, lockTimeoutMs)) return false;
  try {
    prune(file, record.spawned_at_ms);
    fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
    return true;
  } finally {
    releaseLock(lockPath);
  }
}

/** The latest spawn record for `agentId`, or null. Read-only; malformed lines are skipped. */
export function findSpawn(agentId: string, file: string = defaultSpawnPath()): SpawnRecord | null {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const r = JSON.parse(line) as unknown;
      if (isSpawnRecord(r) && r.agent_id === agentId) return r;
    } catch { /* skip malformed */ }
  }
  return null;
}

/**
 * Shape check for a manifest line. A record that names a definition must carry the
 * fields confirmAtStop reads; anything else is skipped like a malformed line, so a
 * hand-edited or foreign line degrades to "no spawn record" rather than a throw.
 */
function isSpawnRecord(r: unknown): r is SpawnRecord {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as Record<string, unknown>;
  if (typeof o.agent_id !== 'string' || typeof o.spawned_at_ms !== 'number') return false;
  if (o.definition === null) return true;
  const d = o.definition as Record<string, unknown> | undefined;
  return typeof d === 'object' && d !== null
    && typeof d.name === 'string' && typeof d.sha256 === 'string' && typeof d.path === 'string'
    && typeof d.mtimeMs === 'number' && (d.version === null || typeof d.version === 'string');
}
