/**
 * SubagentStart → SubagentStop definition capture through the real hook entry points
 * (checklist X4-1, X4-2). Transcripts live under ~/.claude/ to pass handleHook's path
 * guard; definitions and the spawn manifest live in temp dirs injected through deps.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleHook, handleSubagentStart, definitionAtStop } from './hook.js';
import { RELOAD_WINDOW_MS } from './definition.js';
import { findSpawn, recordSpawn, SPAWN_PRUNE_BYTES, SPAWN_TTL_MS } from './spawns.js';
import {
  annotateBufferEntries, appendToBuffer, clearAgents, entriesToTrackerFormat, readBuffer, trackerDefinitionVersion,
  TRACKER_DEFINITION_VERSION_MAX, type BufferConfig, type BufferEntry,
} from './buffer.js';
import { toTrackerFormat } from './extractor.js';
import { createTestMetrics } from './test-utils.js';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const TRANSCRIPTS = path.join(CLAUDE_DIR, `agent-metrics-deftest-${Date.now()}`);
const AGENT = 'feedface0000111122223333aaaabbbb';

describe('definition capture through the hooks (X4-1/X4-2)', () => {
  let tmp: string;
  let agents: string;
  let spawnFile: string;
  let dirs: Array<{ path: string; label: string }>;
  const deps = (): { definitionDirs: typeof dirs; spawnFile: string } => ({ definitionDirs: dirs, spawnFile });
  const writeDef = (version: string | null, body = 'b'): string => {
    const p = path.join(agents, 'code-auditor-agent.md');
    fs.writeFileSync(p, `---\nname: code-auditor\n${version ? `version: "${version}"\n` : ''}---\n\n${body}\n`);
    return p;
  };
  const age = (p: string): void => { const t = new Date(Date.now() - RELOAD_WINDOW_MS - 60_000); fs.utimesSync(p, t, t); };
  const transcript = (): string => {
    const p = path.join(TRANSCRIPTS, `agent-${AGENT}.jsonl`);
    const base = Date.now();
    const common = { cwd: '/x', sessionId: 's', version: '2.1.0', gitBranch: 'main', agentId: AGENT };
    fs.writeFileSync(p, [
      JSON.stringify({ ...common, type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] }, uuid: 'u1', timestamp: new Date(base).toISOString() }),
      JSON.stringify({ ...common, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, uuid: 'u2', timestamp: new Date(base + 1000).toISOString() }),
    ].join('\n') + '\n');
    return p;
  };
  const stop = async (firstMessage = 'go'): Promise<ReturnType<typeof readBuffer>[number] | undefined> => {
    await handleHook({ agent_transcript_path: transcript(), agent_id: AGENT, agent_type: 'code-auditor', cwd: '/x' },
      { ...deps(), readFirstMessage: async () => firstMessage });
    return readBuffer().find(e => e.agent_id === AGENT);
  };

  before(() => fs.mkdirSync(TRANSCRIPTS, { recursive: true }));
  after(() => fs.rmSync(TRANSCRIPTS, { recursive: true, force: true }));
  afterEach(() => {
    clearAgents([AGENT]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const setup = (): void => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-hookdef-'));
    agents = path.join(tmp, 'agents');
    fs.mkdirSync(agents);
    spawnFile = path.join(tmp, 'spawns.jsonl');
    dirs = [{ path: agents, label: 'user' }];
  };

  it('start then stop: the spawn capture is attached, and -f tracker emits definition_version', async () => {
    setup();
    age(writeDef('2.7.3'));
    handleSubagentStart({ hook_event_name: 'SubagentStart', agent_id: AGENT, agent_type: 'code-auditor', cwd: '/x' }, deps());
    assert.strictEqual(findSpawn(AGENT, spawnFile)?.definition?.version, '2.7.3');
    const entry = await stop();
    assert.strictEqual(entry?.definition?.version, '2.7.3');
    assert.strictEqual(entry?.definition?.captured_at, 'spawn');
    assert.match(entry?.definition?.sha256 ?? '', /^[0-9a-f]{64}$/);
    const [tracked] = entriesToTrackerFormat([entry!]);
    assert.strictEqual(tracked?.definition_version, '2.7.3');
    assert.ok(!('sha256' in (tracked as object)) && !('definition' in (tracked as object)), 'only the version reaches the strict save_run schema');
  });

  it('reinstalled between start and stop → omitted, changed-during-run (control: a stop-time read records 2.8.0)', async () => {
    setup();
    const p = writeDef('2.7.3');
    age(p);
    handleSubagentStart({ agent_id: AGENT, agent_type: 'code-auditor', cwd: '/x' }, deps());
    fs.writeFileSync(p, '---\nname: code-auditor\nversion: "2.8.0"\n---\n\nnew\n');
    const entry = await stop();
    assert.strictEqual(entry?.definition, undefined);
    assert.strictEqual(entry?.definition_unresolved, 'changed-during-run');
    assert.strictEqual(entriesToTrackerFormat([entry!])[0]?.definition_version, undefined);
  });

  it('an [agent:] tag naming another definition → omitted, tag-mismatch', async () => {
    setup();
    age(writeDef('2.7.3'));
    handleSubagentStart({ agent_id: AGENT, agent_type: 'code-auditor', cwd: '/x' }, deps());
    const entry = await stop('[agent:executor] go');
    assert.strictEqual(entry?.definition_unresolved, 'tag-mismatch');
    assert.strictEqual(entry?.agent_name, 'executor');
    assert.strictEqual(entriesToTrackerFormat([entry!])[0]?.definition_version, undefined);
  });

  it('no spawn record → a stop-time capture, marked captured_at: stop', async () => {
    setup();
    age(writeDef('2.7.3'));
    const entry = await stop();
    assert.strictEqual(entry?.definition?.version, '2.7.3');
    assert.strictEqual(entry?.definition?.captured_at, 'stop');
  });

  it('a spawn that could not resolve keeps its cause at stop, even if a file appeared since', () => {
    setup();
    handleSubagentStart({ agent_id: AGENT, agent_type: 'code-auditor', cwd: '/x' }, deps());
    writeDef('2.7.3');
    assert.deepStrictEqual(definitionAtStop(AGENT, 'code-auditor', null, deps()), { definitionUnresolved: 'no-file' });
  });

  it('a version is emitted only under its own name (control: a caller-supplied different name)', () => {
    const d = { name: 'code-auditor', version: '2.7.3', sha256: 'x', path: '/p', captured_at: 'spawn' as const };
    assert.strictEqual(trackerDefinitionVersion(d, 'code-auditor'), '2.7.3');
    assert.strictEqual(trackerDefinitionVersion(d, 'security-analyst'), undefined);
    assert.strictEqual(toTrackerFormat(createTestMetrics(), 'code-auditor', '2.7.3').definition_version, '2.7.3');
    assert.ok(!('definition_version' in toTrackerFormat(createTestMetrics(), 'code-auditor')));
  });

  it('spawn manifest: the latest record per agent wins; malformed lines are skipped', () => {
    setup();
    recordSpawn({ agent_id: AGENT, agent_type: 'a', spawned_at_ms: 1, definition: null, unresolved: 'no-file' }, spawnFile);
    fs.appendFileSync(spawnFile, 'not json\n');
    recordSpawn({ agent_id: AGENT, agent_type: 'b', spawned_at_ms: 2, definition: null, unresolved: 'no-version' }, spawnFile);
    assert.strictEqual(findSpawn(AGENT, spawnFile)?.agent_type, 'b');
    assert.strictEqual(findSpawn('0000', spawnFile), null);
  });
});

describe('capture counters (X4-5)', () => {
  it('count versions, causes, nameless and pre-capture entries (control: a log-only reference reports nothing)', async () => {
    const { definitionCaptureStats } = await import('./buffer.js');
    const base = { session_id: 's', captured_at: '', end_time: '', expires_at: '', metrics: createTestMetrics() };
    const d = { name: 'a', version: '1', sha256: '', path: '/p' };
    const stats = definitionCaptureStats([
      { ...base, agent_id: '1', agent_name: 'a', definition: { ...d, captured_at: 'spawn' } },
      { ...base, agent_id: '2', agent_name: 'a', definition: { ...d, captured_at: 'stop' } },
      { ...base, agent_id: '3', definition_unresolved: 'no-agent-type' },
      { ...base, agent_id: '4', agent_name: 'b', definition_unresolved: 'changed-during-run' },
      { ...base, agent_id: '5', agent_name: 'c' },
    ], 2);
    assert.deepStrictEqual(stats, {
      entries: 5, withVersion: 2, capturedAtSpawn: 1, capturedAtStop: 1,
      unresolvedByCause: { 'no-agent-type': 1, 'changed-during-run': 1 },
      noAgentName: 1, preCapture: 1, spilled: 2,
    });
  });
});

describe('review fixes (2026-10-04)', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-review-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const cfg = (): BufferConfig => ({ bufferPath: path.join(tmp, 'buffer.jsonl'), defaultTTL: 3_600_000, lockTimeoutMs: 200 });
  const entry = (agent_id: string, over: Partial<BufferEntry> = {}): BufferEntry => ({
    agent_id, session_id: 's', captured_at: new Date().toISOString(), end_time: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(), metrics: createTestMetrics({ agent_id }), ...over,
  });
  const spill = (c: BufferConfig, e: BufferEntry): string => {
    const dir = c.bufferPath + '.spill';
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${e.agent_id}-1-1.json`);
    fs.writeFileSync(f, JSON.stringify(e));
    return f;
  };

  it('a drained entry is never fused onto a partial last line (control: the partial line is quarantined, both survive)', () => {
    const c = cfg();
    fs.writeFileSync(c.bufferPath, JSON.stringify(entry('aaaa1111')) + '\n{"agent_id":"trunc');
    spill(c, entry('bbbb2222'));
    appendToBuffer(createTestMetrics({ agent_id: 'cccc3333' }), { config: c });
    assert.deepStrictEqual(readBuffer(c).map(e => e.agent_id).sort(), ['aaaa1111', 'bbbb2222', 'cccc3333']);
    assert.deepStrictEqual(fs.readdirSync(c.bufferPath + '.spill'), [], 'drained and removed');
  });

  it('a stranded .claimed file is neither read nor drained again (the duplicate-append failure)', () => {
    const c = cfg();
    const f = spill(c, entry('dddd4444'));
    fs.renameSync(f, f + '.999.claimed');
    assert.deepStrictEqual(readBuffer(c), []);
    appendToBuffer(createTestMetrics({ agent_id: 'eeee5555' }), { config: c });
    assert.deepStrictEqual(readBuffer(c).map(e => e.agent_id), ['eeee5555']);
  });

  it('clearAgents removes a SPILLED entry too (control: before the fix it reappeared on the next read)', () => {
    const c = cfg();
    appendToBuffer(createTestMetrics({ agent_id: 'ffff6666' }), { config: c });
    spill(c, entry('abab7777'));
    assert.strictEqual(readBuffer(c).length, 2);
    clearAgents(['abab7777'], c);
    assert.deepStrictEqual(readBuffer(c).map(e => e.agent_id), ['ffff6666']);
  });

  it('clearAgents and annotate act on EVERY raw line of a re-woken agent, not the collapsed one', () => {
    const c = cfg();
    const early = entry('cdcd8888', { end_time: '2026-10-04T10:00:00.000Z' });
    const late = entry('cdcd8888', { end_time: '2026-10-04T10:05:00.000Z' });
    fs.writeFileSync(c.bufferPath, JSON.stringify(early) + '\n' + JSON.stringify(late) + '\n');
    assert.strictEqual(readBuffer(c).length, 1, 'collapsed on read');
    assert.strictEqual(annotateBufferEntries({ cdcd8888: 'named' }, c), 2);
    const raw = fs.readFileSync(c.bufferPath, 'utf8').trim().split('\n').map(l => JSON.parse(l) as BufferEntry);
    assert.deepStrictEqual(raw.map(e => e.agent_name), ['named', 'named']);
    assert.strictEqual(clearAgents(['cdcd8888'], c), 2);
    assert.strictEqual(fs.readFileSync(c.bufferPath, 'utf8'), '');
  });

  it('a definition_version longer than the save_run limit is omitted, not truncated', () => {
    const d = { name: 'a', version: 'v'.repeat(TRACKER_DEFINITION_VERSION_MAX), sha256: '', path: '/p', captured_at: 'spawn' as const };
    assert.strictEqual(trackerDefinitionVersion(d, 'a'), d.version);
    assert.strictEqual(trackerDefinitionVersion({ ...d, version: d.version + 'x' }, 'a'), undefined);
  });

  it('a malformed spawn record is skipped, not trusted (shape check)', () => {
    const file = path.join(tmp, 'spawns.jsonl');
    fs.writeFileSync(file, JSON.stringify({ agent_id: AGENT, spawned_at_ms: 1, definition: { name: 'x', version: '1' } }) + '\n');
    assert.strictEqual(findSpawn(AGENT, file), null);
    fs.appendFileSync(file, JSON.stringify({ agent_id: AGENT, spawned_at_ms: 2, definition: null, unresolved: 'no-file' }) + '\n');
    assert.strictEqual(findSpawn(AGENT, file)?.spawned_at_ms, 2);
  });

  it('a throw inside definition capture degrades to capture-error, never kills the metrics capture', () => {
    const deps = { get definitionDirs(): never { throw new Error('boom'); }, spawnFile: path.join(tmp, 'none.jsonl') };
    assert.deepStrictEqual(definitionAtStop(AGENT, 'code-auditor', null, deps), { definitionUnresolved: 'capture-error' });
  });

  it('the spawn prune rewrites atomically and keeps only live records', () => {
    const file = path.join(tmp, 'spawns.jsonl');
    const now = Date.now();
    const stale = JSON.stringify({ agent_id: 'old', spawned_at_ms: now - SPAWN_TTL_MS - 1, definition: null, unresolved: 'no-file' });
    fs.writeFileSync(file, (stale + '\n').repeat(Math.ceil(SPAWN_PRUNE_BYTES / stale.length) + 1));
    recordSpawn({ agent_id: AGENT, agent_type: 'a', spawned_at_ms: now, definition: null, unresolved: 'no-file' }, file);
    assert.strictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
    assert.deepStrictEqual(fs.readdirSync(tmp).filter(f => f.endsWith('.tmp')), [], 'no temp file left behind');
  });
});
