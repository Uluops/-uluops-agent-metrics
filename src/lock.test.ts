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
});
