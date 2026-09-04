/**
 * Reconcile Command Tests
 *
 * Spec: uluops-specifications 01-reconcile-run-expect-command-spec-v0_1_0.md §7.
 * Tracker: 5f8ed1df-805c-4985-9750-637475a50d4d.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { registerReconcileCommands } from './reconcile.js';
import { appendToBuffer } from '../buffer.js';
import { createCommandTestHarness, createTestMetrics, type CommandTestHarness } from '../test-utils.js';

const TEST_DIR = path.join(os.tmpdir(), 'agent-metrics-reconcile-commands-test-' + Date.now());

describe('Reconcile Command', () => {
  let harness: CommandTestHarness;
  let program: CommandTestHarness['program'];
  const originalEnv = { ...process.env };

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    process.env.HOME = TEST_DIR;
    harness = createCommandTestHarness();
    program = harness.program;
    registerReconcileCommands(program);
  });

  afterEach(() => {
    harness.restore();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('case 1: attributed === expected exits 0 with status "exact"', async () => {
    appendToBuffer(createTestMetrics(), { runId: 't' });
    appendToBuffer(createTestMetrics(), { runId: 't' });
    appendToBuffer(createTestMetrics(), { runId: 't' });

    await program.parseAsync(['node', 'test', 'reconcile', '--run', 't', '--expect', '3', '-f', 'json']);

    assert.strictEqual(harness.exitCode, null, 'exact match must not call process.exit with a non-zero code (process exits 0 naturally)');
    const parsed = JSON.parse(harness.stdout.join('\n'));
    assert.strictEqual(parsed.status, 'exact');
    assert.strictEqual(parsed.attributed, 3);
    assert.strictEqual(parsed.expected, 3);
    assert.strictEqual(parsed.shortfall, 0);
  });

  it('case 2: attributed < expected exits 1 with shortfall and a SHORTFALL diagnostic on stderr', async () => {
    appendToBuffer(createTestMetrics(), { runId: 't' });
    appendToBuffer(createTestMetrics(), { runId: 't' });

    try {
      await program.parseAsync(['node', 'test', 'reconcile', '--run', 't', '--expect', '3', '-f', 'json']);
      assert.fail('Should have thrown (process.exit stub)');
    } catch {
      assert.strictEqual(harness.exitCode, 1, 'shortfall must exit 1 — not 0, the comparison must not be inverted');
      const parsed = JSON.parse(harness.stdout.join('\n'));
      assert.strictEqual(parsed.status, 'shortfall');
      assert.strictEqual(parsed.shortfall, 1);
      assert.ok(harness.stderr.some(l => l.includes('SHORTFALL')), 'stderr must contain a SHORTFALL diagnostic');
    }
  });

  it('case 3: attributed > expected exits 0 with status "over" and a stderr note (benign, not an error)', async () => {
    for (let i = 0; i < 4; i++) {
      appendToBuffer(createTestMetrics(), { runId: 't' });
    }

    await program.parseAsync(['node', 'test', 'reconcile', '--run', 't', '--expect', '3', '-f', 'json']);

    assert.strictEqual(harness.exitCode, null, 'over-collection must not call process.exit with a non-zero code (process exits 0 naturally) — benign, not an error');
    const parsed = JSON.parse(harness.stdout.join('\n'));
    assert.strictEqual(parsed.status, 'over');
    assert.strictEqual(parsed.attributed, 4);
    assert.strictEqual(parsed.shortfall, -1);
    assert.ok(harness.stderr.some(l => l.toLowerCase().includes('over-collection')), 'stderr must note over-collection');
  });

  describe('case 4: usage errors on --expect exit 2, distinct from the shortfall exit (1)', () => {
    for (const badExpect of ['abc', '0', '-1']) {
      it(`--expect ${badExpect} exits 2 without reading the buffer`, async () => {
        appendToBuffer(createTestMetrics(), { runId: 't' });

        try {
          await program.parseAsync(['node', 'test', 'reconcile', '--run', 't', '--expect', badExpect]);
          assert.fail('Should have thrown (process.exit stub)');
        } catch {
          assert.strictEqual(harness.exitCode, 2, `--expect ${badExpect} must exit 2 (usage error)`);
        }
      });
    }
  });

  it('case 5: missing --run exits 2', async () => {
    try {
      await program.parseAsync(['node', 'test', 'reconcile', '--expect', '3']);
      assert.fail('Should have thrown (process.exit stub)');
    } catch {
      assert.strictEqual(harness.exitCode, 2, 'missing --run must exit 2 (usage error)');
    }
  });

  it('case 6: --run is lowercased before matching, parity with buffer list', async () => {
    appendToBuffer(createTestMetrics(), { runId: 't' });

    await program.parseAsync(['node', 'test', 'reconcile', '--run', 'T', '--expect', '1', '-f', 'json']);

    assert.strictEqual(harness.exitCode, null);
    const parsed = JSON.parse(harness.stdout.join('\n'));
    assert.strictEqual(parsed.status, 'exact');
    assert.strictEqual(parsed.run_id, 't');
  });

  it('case 7: rows exist for a different run token — an empty attributed set is a shortfall, never a pass', async () => {
    appendToBuffer(createTestMetrics(), { runId: 'other-run' });

    try {
      await program.parseAsync(['node', 'test', 'reconcile', '--run', 'no-such-run', '--expect', '3', '-f', 'json']);
      assert.fail('Should have thrown (process.exit stub) — zero attributed rows must not exit 0');
    } catch {
      assert.strictEqual(harness.exitCode, 1, 'zero attributed rows for the token must be a shortfall, exit 1');
      const parsed = JSON.parse(harness.stdout.join('\n'));
      assert.strictEqual(parsed.attributed, 0);
      assert.strictEqual(parsed.status, 'shortfall');
    }
  });

  it('case 8: -f json — stdout parses as exactly one object; the diagnostic is on stderr, not stdout', async () => {
    appendToBuffer(createTestMetrics(), { runId: 't' });

    try {
      await program.parseAsync(['node', 'test', 'reconcile', '--run', 't', '--expect', '2', '-f', 'json']);
      assert.fail('Should have thrown (process.exit stub)');
    } catch {
      assert.strictEqual(harness.stdout.length, 1, 'stdout must carry exactly one line (one JSON.stringify call)');
      const parsed = JSON.parse(harness.stdout[0]!);
      assert.strictEqual(typeof parsed, 'object');
      assert.strictEqual(parsed.status, 'shortfall');
      assert.ok(!harness.stdout.join('\n').includes('SHORTFALL'), 'the diagnostic text must not appear on stdout');
      assert.ok(harness.stderr.some(l => l.includes('SHORTFALL')), 'the diagnostic text must appear on stderr');
    }
  });

  it('run_id appears in the JSON envelope but never inside an agents[]-shaped tracker payload (spec §3.3)', async () => {
    appendToBuffer(createTestMetrics(), { runId: 't', agentName: 'code-validator' });

    await program.parseAsync(['node', 'test', 'reconcile', '--run', 't', '--expect', '1', '-f', 'json']);

    const parsed = JSON.parse(harness.stdout.join('\n'));
    assert.strictEqual(parsed.run_id, 't');
    assert.strictEqual(parsed.agents.length, 1);
    for (const agent of parsed.agents) {
      assert.deepStrictEqual(Object.keys(agent).sort(), ['agent_id', 'agent_name'].sort(), 'agents[] must carry exactly agent_id + agent_name — never a tracker-shaped row, never run_id');
    }
  });

  it('-p project filters attributed entries by project_path partial match, parity with buffer list -p', async () => {
    appendToBuffer(createTestMetrics(), { runId: 't', projectPath: '/repo/agent-metrics' });
    appendToBuffer(createTestMetrics(), { runId: 't', projectPath: '/repo/other-project' });

    await program.parseAsync(['node', 'test', 'reconcile', '--run', 't', '--expect', '1', '-p', 'agent-metrics', '-f', 'json']);

    assert.strictEqual(harness.exitCode, null);
    const parsed = JSON.parse(harness.stdout.join('\n'));
    assert.strictEqual(parsed.attributed, 1);
  });

  it('control: text format (default) still works and includes the buffer row list', async () => {
    appendToBuffer(createTestMetrics(), { runId: 't' });

    await program.parseAsync(['node', 'test', 'reconcile', '--run', 't', '--expect', '1']);

    assert.strictEqual(harness.exitCode, null);
    const textOut = harness.stdout.join('\n');
    assert.ok(textOut.includes('Run token: t'));
    assert.ok(textOut.includes('Expected:  1'));
    assert.ok(textOut.includes('Attributed: 1'));
  });
});
