/**
 * The hook binary as Claude Code runs it (2026-10-04 review, test-architect): stdin JSON
 * into dist/hook.js, dispatched by `hook_event_name`. The unit tests call
 * handleSubagentStart directly, so a regression in main()'s dispatch — SubagentStart
 * falling through to the stop path, or printing a decision — passed every one of them.
 * HOME is redirected so the spawn manifest and agent directory are the test's own.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, 'hook.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'am-hook-e2e-'));
const AGENT = 'abcdef0123456789abcdef0123456789';

const run = (payload: object): ReturnType<typeof spawnSync> =>
  spawnSync(process.execPath, [HOOK_PATH], { input: JSON.stringify(payload), env: { ...process.env, HOME }, encoding: 'utf8', timeout: 15_000 });

describe('hook binary dispatch (spawned dist/hook.js)', () => {
  before(() => {
    assert.ok(fs.existsSync(HOOK_PATH), `Expected built hook at ${HOOK_PATH} — run "npm run build" first`);
    const agents = path.join(HOME, '.claude', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'code-auditor-agent.md'), '---\nname: code-auditor\nversion: "2.7.3"\n---\n\nbody\n');
  });
  after(() => fs.rmSync(HOME, { recursive: true, force: true }));

  it('SubagentStart records the spawn-time definition and prints nothing (control: a stop payload prints a decision)', () => {
    const start = run({ hook_event_name: 'SubagentStart', agent_id: AGENT, agent_type: 'code-auditor', cwd: HOME });
    assert.strictEqual(start.status, 0);
    assert.strictEqual(start.stdout, '', 'SubagentStart must not emit a decision');
    const manifest = path.join(HOME, '.claude', 'agent-metrics-spawns.jsonl');
    const records = fs.readFileSync(manifest, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { agent_id: string; definition: { version: string } | null });
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0]!.agent_id, AGENT);
    assert.strictEqual(records[0]!.definition?.version, '2.7.3');

    const stop = run({ hook_event_name: 'SubagentStop', agent_id: AGENT, agent_type: 'code-auditor', cwd: HOME });
    assert.strictEqual(stop.status, 0);
    assert.deepStrictEqual(JSON.parse(String(stop.stdout).trim()), { decision: 'approve' });
    assert.strictEqual(fs.readFileSync(manifest, 'utf8').trim().split('\n').length, 1, 'the stop path records no spawn');
  });
});
