/**
 * Lock Module Tests
 *
 * Direct tests for acquireLock, releaseLock, and withFileLock.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { acquireLock, releaseLock, withFileLock } from './lock.js';

const TEST_DIR = path.join(os.tmpdir(), 'agent-metrics-lock-test-' + Date.now());

describe('Lock Module', () => {
  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Clean up any leftover lock files
    for (const file of fs.readdirSync(TEST_DIR)) {
      if (file.endsWith('.lock')) {
        fs.unlinkSync(path.join(TEST_DIR, file));
      }
    }
  });

  describe('acquireLock', () => {
    it('should acquire lock when no lock exists', () => {
      const lockPath = path.join(TEST_DIR, 'test1.lock');
      const acquired = acquireLock(lockPath);
      assert.strictEqual(acquired, true);
      assert.ok(fs.existsSync(lockPath));
      releaseLock(lockPath);
    });

    it('should write PID to lock file', () => {
      const lockPath = path.join(TEST_DIR, 'test-pid.lock');
      acquireLock(lockPath);
      const content = fs.readFileSync(lockPath, 'utf-8');
      assert.strictEqual(content, String(process.pid));
      releaseLock(lockPath);
    });

    it('should fail to acquire when lock is held and not stale', () => {
      const lockPath = path.join(TEST_DIR, 'test2.lock');
      // Create a fresh lock file (not stale)
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });

      const acquired = acquireLock(lockPath, 200); // Short timeout
      assert.strictEqual(acquired, false);
      releaseLock(lockPath);
    });

    it('should remove stale lock older than 30 seconds', () => {
      const lockPath = path.join(TEST_DIR, 'test-stale.lock');
      // Create a lock file and backdate it
      fs.writeFileSync(lockPath, '99999');
      const staleTime = new Date(Date.now() - 31000);
      fs.utimesSync(lockPath, staleTime, staleTime);

      const acquired = acquireLock(lockPath, 1000);
      assert.strictEqual(acquired, true);
      releaseLock(lockPath);
    });

    it('should NOT remove lock younger than 30 seconds', () => {
      const lockPath = path.join(TEST_DIR, 'test-fresh.lock');
      // Create a fresh lock
      fs.writeFileSync(lockPath, '99999');

      const acquired = acquireLock(lockPath, 200);
      assert.strictEqual(acquired, false);
      releaseLock(lockPath);
    });

    it('should succeed after stale lock is detected and removed', () => {
      const lockPath = path.join(TEST_DIR, 'test-retry.lock');
      // Create a lock and backdate it past the 30s stale threshold
      fs.writeFileSync(lockPath, '99999');
      const staleTime = new Date(Date.now() - 35000);
      fs.utimesSync(lockPath, staleTime, staleTime);

      const acquired = acquireLock(lockPath, 2000);
      assert.strictEqual(acquired, true);
      releaseLock(lockPath);
    });
  });

  describe('releaseLock', () => {
    it('should remove lock file', () => {
      const lockPath = path.join(TEST_DIR, 'release1.lock');
      fs.writeFileSync(lockPath, String(process.pid));
      assert.ok(fs.existsSync(lockPath));

      releaseLock(lockPath);
      assert.ok(!fs.existsSync(lockPath));
    });

    it('should be idempotent — no error on missing file', () => {
      const lockPath = path.join(TEST_DIR, 'release-missing.lock');
      // Should not throw
      releaseLock(lockPath);
      releaseLock(lockPath);
    });

    it('issue 7bbc20b8: should not throw and should report on stderr when unlink fails for a non-ENOENT reason', () => {
      if (process.getuid?.() === 0) {
        return;
      }
      const restrictedDir = path.join(TEST_DIR, 'release-restricted');
      fs.mkdirSync(restrictedDir, { recursive: true });
      const lockPath = path.join(restrictedDir, 'held.lock');
      fs.writeFileSync(lockPath, String(process.pid));
      // Unlink needs write permission on the *parent* dir, not the file.
      fs.chmodSync(restrictedDir, 0o500);

      const originalWrite = process.stderr.write;
      let captured = '';
      process.stderr.write = ((msg: string | Uint8Array) => {
        captured += typeof msg === 'string' ? msg : msg.toString();
        return true;
      }) as typeof process.stderr.write;

      try {
        releaseLock(lockPath); // must not throw
        assert.ok(captured.includes(lockPath), 'stderr diagnostic should name the lock path');
        assert.ok(fs.existsSync(lockPath), 'file should still exist — unlink failed');
      } finally {
        process.stderr.write = originalWrite;
        fs.chmodSync(restrictedDir, 0o700);
        fs.unlinkSync(lockPath);
      }
    });

    it('companion: releaseLock on a missing file emits nothing on stderr', () => {
      const lockPath = path.join(TEST_DIR, 'release-missing-silent.lock');
      const originalWrite = process.stderr.write;
      let captured = '';
      process.stderr.write = ((msg: string | Uint8Array) => {
        captured += typeof msg === 'string' ? msg : msg.toString();
        return true;
      }) as typeof process.stderr.write;

      try {
        releaseLock(lockPath);
        assert.strictEqual(captured, '', 'ENOENT release must be fully silent');
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });

  describe('withFileLock', () => {
    it('should execute function and return result', () => {
      const lockPath = path.join(TEST_DIR, 'with1.lock');
      const result = withFileLock(lockPath, 5000, () => 42);
      assert.strictEqual(result, 42);
      assert.ok(!fs.existsSync(lockPath), 'Lock should be released after');
    });

    it('should release lock even when function throws', () => {
      const lockPath = path.join(TEST_DIR, 'with-throw.lock');
      assert.throws(() => {
        withFileLock(lockPath, 5000, () => {
          throw new Error('test error');
        });
      }, { message: 'test error' });
      assert.ok(!fs.existsSync(lockPath), 'Lock should be released after exception');
    });

    it('should propagate the thrown error type', () => {
      const lockPath = path.join(TEST_DIR, 'with-error-type.lock');
      try {
        withFileLock(lockPath, 5000, () => {
          throw new TypeError('type error');
        });
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof TypeError);
      }
    });

    it('should pass through return type generics', () => {
      const lockPath = path.join(TEST_DIR, 'with-generic.lock');
      const result: string[] = withFileLock(lockPath, 5000, () => ['a', 'b']);
      assert.deepStrictEqual(result, ['a', 'b']);
    });

    it('should fail closed: throw LockAcquisitionError and NOT run fn when lock is held', () => {
      const lockPath = path.join(TEST_DIR, 'with-contended.lock');
      // Simulate a live holder (fresh mtime, so not stale-reclaimed)
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });

      let fnRan = false;
      try {
        assert.throws(
          () => withFileLock(lockPath, 100, () => { fnRan = true; }),
          { name: 'LockAcquisitionError' },
        );
        assert.strictEqual(fnRan, false, 'fn must not run without the lock');
        assert.ok(fs.existsSync(lockPath), 'Held lock must not be released by the failed acquirer');
      } finally {
        fs.unlinkSync(lockPath);
      }
    });

    it('should create the lock parent directory when missing', () => {
      const lockPath = path.join(TEST_DIR, 'no-such-dir', 'nested', 'x.lock');
      const result = withFileLock(lockPath, 5000, () => 'ok');
      assert.strictEqual(result, 'ok');
      assert.ok(!fs.existsSync(lockPath), 'Lock released after');
    });
  });

  describe('acquireLock — non-EEXIST write errors fall through to backoff (10b297e8)', () => {
    it('should not spin retrying writeFileSync when the write error is not EEXIST', () => {
      const lockPath = path.join(TEST_DIR, 'stale-check-spin.lock');
      let writeAttempts = 0;
      const deps = {
        writeFileSync: (() => {
          writeAttempts++;
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }) as unknown as typeof fs.writeFileSync,
        statSync: (() => {
          const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }) as unknown as typeof fs.statSync,
      };

      const acquired = acquireLock(lockPath, 300, deps);
      assert.strictEqual(acquired, false);
      assert.ok(
        writeAttempts <= 10,
        `expected <= 10 write attempts on non-EEXIST error, got ${writeAttempts}`,
      );
    });

    it('should still reclaim a stale lock when the write error is EEXIST (unchanged behavior)', () => {
      if (process.getuid?.() === 0) {
        return;
      }
      const lockPath = path.join(TEST_DIR, 'real-perm-denied.lock');
      const acquired = acquireLock(lockPath, 1000);
      assert.strictEqual(acquired, true);
      releaseLock(lockPath);
    });

    it('should fall through to backoff and respect maxWaitMs on a real unwritable parent dir', () => {
      if (process.getuid?.() === 0) {
        return;
      }
      const restrictedDir = path.join(TEST_DIR, 'restricted-parent');
      fs.mkdirSync(restrictedDir, { recursive: true });
      const lockPath = path.join(restrictedDir, 'sub', 'x.lock');
      // Pre-create the 'sub' dir so mkdirSync(recursive) in acquireLock succeeds,
      // then chmod the parent read-only so writeFileSync fails with EACCES (not EEXIST).
      fs.mkdirSync(path.join(restrictedDir, 'sub'), { recursive: true });
      fs.chmodSync(path.join(restrictedDir, 'sub'), 0o500);
      try {
        const start = Date.now();
        const acquired = acquireLock(lockPath, 300);
        const elapsed = Date.now() - start;
        assert.strictEqual(acquired, false);
        assert.ok(elapsed < 2000, `expected acquireLock to respect maxWaitMs, took ${elapsed}ms`);
      } finally {
        fs.chmodSync(path.join(restrictedDir, 'sub'), 0o700);
      }
    });
  });

  describe('state file permissions (spec 05, Option A: mode 0600 on write)', () => {
    function skip(): boolean {
      return process.getuid?.() === 0 || process.platform === 'win32';
    }

    it('3: a held lock file has mode 0600', () => {
      if (skip()) return;
      const lockPath = path.join(TEST_DIR, 'perm-test.lock');
      const acquired = acquireLock(lockPath);
      assert.strictEqual(acquired, true);
      try {
        const mode = fs.statSync(lockPath).mode & 0o777;
        assert.strictEqual(mode, 0o600, `expected lock mode 0600, got ${mode.toString(8)}`);
      } finally {
        releaseLock(lockPath);
      }
    });

    it('the lock directory is created with mode 0700', () => {
      if (skip()) return;
      const freshDir = path.join(TEST_DIR, 'perm-lock-subdir');
      const lockPath = path.join(freshDir, 'x.lock');
      const acquired = acquireLock(lockPath);
      assert.strictEqual(acquired, true);
      try {
        const mode = fs.statSync(freshDir).mode & 0o777;
        assert.strictEqual(mode, 0o700, `expected lock dir mode 0700, got ${mode.toString(8)}`);
      } finally {
        releaseLock(lockPath);
      }
    });
  });
});
