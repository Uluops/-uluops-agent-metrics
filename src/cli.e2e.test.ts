/**
 * CLI Entry Point E2E Tests
 *
 * Spawns the built binary directly (dist/cli.js) because these tests exercise
 * the top-level `program.parseAsync()` wiring in cli.ts, which no in-process
 * harness (createCommandTestHarness) touches — that harness builds its own
 * Command and never imports cli.ts.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// This test file is compiled to dist/cli.e2e.test.js, alongside dist/cli.js —
// resolve the sibling build output rather than assuming a fixed relative path
// from the source tree, so the test is robust to how `npm test` lays out dist/.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, 'cli.js');

const TEST_DIR = path.join(os.tmpdir(), 'agent-metrics-cli-e2e-test-' + Date.now());

describe('CLI entry point (spawned binary)', () => {
  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    assert.ok(fs.existsSync(CLI_PATH), `Expected built CLI at ${CLI_PATH} — run "npm run build" or "npm test" first`);
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('AF-001: an async command rejection surfaces as exit 1 with a clean stderr message, not an unhandled rejection', () => {
    if (process.getuid?.() === 0) {
      // Root bypasses filesystem permission bits, so chmod 0o000 would not
      // reproduce the EACCES this test depends on (precedent: core.test.ts).
      return;
    }

    const homeDir = path.join(TEST_DIR, 'af-001-home');
    const projectsDir = path.join(homeDir, '.claude', 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.chmodSync(projectsDir, 0o000);

    try {
      const result = spawnSync(process.execPath, [CLI_PATH, 'find', 'abc1234'], {
        env: { ...process.env, HOME: homeDir },
        encoding: 'utf-8',
      });

      assert.strictEqual(result.status, 1, `Expected exit code 1, got ${result.status}. stderr: ${result.stderr}`);
      // An unhandled rejection surfaces as Node's default uncaught-exception
      // dump: a raw stack trace ending in the interpreter version footer.
      // A caught-and-reported error prints one clean line instead — no
      // "ERR_UNHANDLED_REJECTION" marker, no stack frames, no version footer.
      assert.ok(
        !result.stderr.includes('ERR_UNHANDLED_REJECTION'),
        `stderr must not contain an unhandled rejection trace:\n${result.stderr}`
      );
      assert.ok(
        !/^Node\.js v/m.test(result.stderr),
        `stderr must not contain a raw uncaught-exception dump (interpreter version footer):\n${result.stderr}`
      );
      assert.ok(
        !/\n\s+at /.test(result.stderr),
        `stderr must not contain a raw stack trace:\n${result.stderr}`
      );
      assert.ok(
        /EACCES/.test(result.stderr) && /Error finding agent file/.test(result.stderr),
        `Expected a clean "Error finding agent file: ...EACCES..." message on stderr, got:\n${result.stderr}`
      );
    } finally {
      fs.chmodSync(projectsDir, 0o755);
    }
  });
});
