/**
 * Hook Module Tests
 *
 * Tests for the SubagentStop hook functionality including:
 * - Agent ID validation
 * - Agent name detection from transcripts
 * - Agent ID extraction from file paths
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  isValidAgentId,
  extractAgentIdFromPath,
  detectAgentName,
  extractExplicitAgentTag,
  extractRunTag,
  detectRunToken,
  sanitizeLineSafe,
  getFirstUserMessageContent,
  handleHook,
  parseHookInput,
  readStdin,
  AGENT_ID_PATTERN,
} from './hook.js';
import { Readable } from 'node:stream';
import { configureLogger, getLoggerConfig, readRecentLogs } from './logger.js';

// Test configuration with isolated temp directory
const TEST_DIR = path.join(os.tmpdir(), 'agent-metrics-hook-test-' + Date.now());

/**
 * Create a single-line JSONL transcript file with one user message, for
 * exercising detectAgentName/detectRunToken. `prefix` only affects the
 * generated filename (useful for distinguishing fixtures across describe
 * blocks in test output); the emitted JSON content is identical regardless.
 */
function createTestTranscript(userMessage: string, prefix = 'transcript'): string {
  const filePath = path.join(TEST_DIR, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const content = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: userMessage,
    },
    timestamp: new Date().toISOString(),
  });
  fs.writeFileSync(filePath, content + '\n');
  return filePath;
}

describe('Hook Module', () => {
  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('parseHookInput', () => {
    it('should parse agent_type when present', () => {
      const result = parseHookInput({
        session_id: 's1',
        cwd: '/tmp/proj',
        agent_id: 'a80e24f',
        agent_type: 'code-validator',
      });

      assert.strictEqual(result.agent_type, 'code-validator');
    });

    it('should omit agent_type when absent or non-string', () => {
      assert.strictEqual(parseHookInput({ session_id: 's1', cwd: '/tmp' }).agent_type, undefined);
      assert.strictEqual(parseHookInput({ session_id: 's1', cwd: '/tmp', agent_type: 42 }).agent_type, undefined);
    });

    it('should strip control characters from agent_type', () => {
      // Newline would split a JSONL buffer line and cause silent metric loss
      const result = parseHookInput({ session_id: 's1', cwd: '/tmp', agent_type: 'code\nvalidator' });
      assert.strictEqual(result.agent_type, 'codevalidator');
      assert.ok(!result.agent_type.includes('\n'), 'agent_type must not contain newline');
    });

    it('should cap agent_type at 64 characters', () => {
      const long = 'a'.repeat(100);
      const result = parseHookInput({ session_id: 's1', cwd: '/tmp', agent_type: long });
      assert.ok(result.agent_type !== undefined);
      assert.ok(result.agent_type!.length <= 64, `agent_type length should be ≤ 64, got ${result.agent_type!.length}`);
    });

    it('should omit agent_type when it consists entirely of control characters', () => {
      const result = parseHookInput({ session_id: 's1', cwd: '/tmp', agent_type: '\n\r\t' });
      assert.strictEqual(result.agent_type, undefined);
    });

    it('should return empty object for non-object input', () => {
      assert.deepStrictEqual(parseHookInput(null), {});
      assert.deepStrictEqual(parseHookInput('nope'), {});
    });
  });

  describe('isValidAgentId', () => {
    it('should accept valid lowercase hex agent IDs', () => {
      assert.strictEqual(isValidAgentId('a80e24f'), true);
      assert.strictEqual(isValidAgentId('ac51171'), true);
      assert.strictEqual(isValidAgentId('0123456789abcdef'), true);
      assert.strictEqual(isValidAgentId('abc'), true);
    });

    it('should reject uppercase letters', () => {
      assert.strictEqual(isValidAgentId('A80E24F'), false);
      assert.strictEqual(isValidAgentId('ABC123'), false);
      assert.strictEqual(isValidAgentId('a80e24F'), false); // Mixed case
    });

    it('should reject non-hex characters', () => {
      assert.strictEqual(isValidAgentId('g123456'), false);
      assert.strictEqual(isValidAgentId('xyz'), false);
      assert.strictEqual(isValidAgentId('abc-def'), false);
      assert.strictEqual(isValidAgentId('abc_def'), false);
      assert.strictEqual(isValidAgentId('abc def'), false);
    });

    it('should reject empty string', () => {
      assert.strictEqual(isValidAgentId(''), false);
    });

    it('should reject strings with special characters', () => {
      assert.strictEqual(isValidAgentId('abc!def'), false);
      assert.strictEqual(isValidAgentId('abc@def'), false);
      assert.strictEqual(isValidAgentId('../abc'), false);
      assert.strictEqual(isValidAgentId('abc/def'), false);
    });
  });

  describe('AGENT_ID_PATTERN', () => {
    it('should match valid hex strings', () => {
      assert.ok(AGENT_ID_PATTERN.test('a80e24f'));
      assert.ok(AGENT_ID_PATTERN.test('0123456789abcdef'));
    });

    it('should not match invalid strings', () => {
      assert.ok(!AGENT_ID_PATTERN.test('ABC'));
      assert.ok(!AGENT_ID_PATTERN.test(''));
      assert.ok(!AGENT_ID_PATTERN.test('xyz'));
    });
  });

  describe('extractAgentIdFromPath', () => {
    it('should extract agent ID from valid paths', () => {
      assert.strictEqual(
        extractAgentIdFromPath('~/.claude/projects/test/agent-a80e24f.jsonl'),
        'a80e24f'
      );
      assert.strictEqual(
        extractAgentIdFromPath('/home/user/.claude/projects/foo/agent-abc123.jsonl'),
        'abc123'
      );
      assert.strictEqual(
        extractAgentIdFromPath('agent-deadbeef.jsonl'),
        'deadbeef'
      );
    });

    it('should return null for non-agent files', () => {
      assert.strictEqual(
        extractAgentIdFromPath('/path/to/session.jsonl'),
        null
      );
      assert.strictEqual(
        extractAgentIdFromPath('/path/to/random-file.txt'),
        null
      );
      assert.strictEqual(
        extractAgentIdFromPath('/path/to/agent-ABC123.jsonl'), // Uppercase
        null
      );
    });

    it('should return null for malformed agent filenames', () => {
      assert.strictEqual(
        extractAgentIdFromPath('agent-.jsonl'),
        null
      );
      assert.strictEqual(
        extractAgentIdFromPath('agent-abc123.json'), // Wrong extension
        null
      );
      assert.strictEqual(
        extractAgentIdFromPath('Agent-abc123.jsonl'), // Wrong case
        null
      );
    });
  });

  describe('detectAgentName', () => {
    it('should detect [agent:name] explicit tag', async () => {
      const filePath = createTestTranscript('[agent:code-validator] Validate code quality');
      const result = await detectAgentName(filePath);
      assert.strictEqual(result, 'code-validator');
    });

    it('should not detect legacy [validator:name] tag', async () => {
      const filePath = createTestTranscript('[validator:test-architect] Check tests');
      const result = await detectAgentName(filePath);
      assert.strictEqual(result, null);
    });

    it('should detect tag mid-content', async () => {
      const filePath = createTestTranscript('Please [agent:security-analyst] review the auth flow');
      const result = await detectAgentName(filePath);
      assert.strictEqual(result, 'security-analyst');
    });

    it('should return null when only a bare agent name appears (no tag)', async () => {
      const filePath = createTestTranscript('Run code-validator on this directory');
      const result = await detectAgentName(filePath);
      assert.strictEqual(result, null);
    });

    it('should return null when no tag is present', async () => {
      const filePath = createTestTranscript('Just do some regular work please');
      const result = await detectAgentName(filePath);
      assert.strictEqual(result, null);
    });

    it('should return null for empty file', async () => {
      const filePath = path.join(TEST_DIR, 'empty.jsonl');
      fs.writeFileSync(filePath, '');
      const result = await detectAgentName(filePath);
      assert.strictEqual(result, null);
    });

    it('should return null for non-existent file', async () => {
      const result = await detectAgentName('/non/existent/file.jsonl');
      assert.strictEqual(result, null);
    });

    it('should handle malformed JSON gracefully', async () => {
      const filePath = path.join(TEST_DIR, 'malformed.jsonl');
      fs.writeFileSync(filePath, 'not valid json\n');
      const result = await detectAgentName(filePath);
      assert.strictEqual(result, null);
    });

    it('should only check the first user message', async () => {
      const filePath = path.join(TEST_DIR, 'multi-message.jsonl');
      const lines = [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'Hello, help me with something' },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: 'Sure!' },
        }),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: '[agent:code-validator] Now run validation' },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const result = await detectAgentName(filePath);
      // Should NOT detect code-validator because the tag is in the second user message
      assert.strictEqual(result, null);
    });

    it('should handle content as array with tag', async () => {
      const filePath = path.join(TEST_DIR, 'array-content.jsonl');
      const content = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '[agent:security-analyst] Review auth' },
          ],
        },
      });
      fs.writeFileSync(filePath, content + '\n');

      const result = await detectAgentName(filePath);
      assert.strictEqual(result, 'security-analyst');
    });
  });

  describe('extractExplicitAgentTag', () => {
    it('should extract from [agent:name]', () => {
      assert.strictEqual(extractExplicitAgentTag('[agent:code-validator] do work'), 'code-validator');
    });

    it('should not extract from legacy [validator:name]', () => {
      assert.strictEqual(extractExplicitAgentTag('[validator:test-architect] do work'), null);
    });

    it('should lowercase the result', () => {
      assert.strictEqual(extractExplicitAgentTag('[AGENT:Code-Validator] work'), 'code-validator');
    });

    it('should return null when no tag is present', () => {
      assert.strictEqual(extractExplicitAgentTag('code-validator please'), null);
      assert.strictEqual(extractExplicitAgentTag(''), null);
    });

    it('should reject malformed tags', () => {
      assert.strictEqual(extractExplicitAgentTag('[agent:]'), null);
      assert.strictEqual(extractExplicitAgentTag('[agent: name]'), null);
      assert.strictEqual(extractExplicitAgentTag('agent:name'), null);
    });
  });

  describe('extractRunTag', () => {
    it('should extract a run token from [run:token]', () => {
      assert.strictEqual(
        extractRunTag('[run:agent-metrics-ir-4625f30d-01] work'),
        'agent-metrics-ir-4625f30d-01'
      );
    });

    it('should co-exist with an [agent:] tag on the same line', () => {
      assert.strictEqual(
        extractRunTag('[agent:executor] [run:proj-ir-9zz1a2b3-02] go'),
        'proj-ir-9zz1a2b3-02'
      );
    });

    it('should permit a leading digit (wider grammar than agent names)', () => {
      assert.strictEqual(extractRunTag('[run:0abc-de] x'), '0abc-de');
    });

    it('should return null when no run tag is present', () => {
      assert.strictEqual(extractRunTag('no tag here'), null);
      assert.strictEqual(extractRunTag(''), null);
      assert.strictEqual(extractRunTag('[agent:executor] only'), null);
    });

    it('should reject malformed run tags', () => {
      assert.strictEqual(extractRunTag('[run:]'), null);
      assert.strictEqual(extractRunTag('[run: token]'), null);
      assert.strictEqual(extractRunTag('[run:ab]'), null); // 2 chars: below the 3-char minimum
      assert.strictEqual(extractRunTag('run:token'), null);
    });

    it('should accept the exact 3-char minimum-length token (inclusive boundary)', () => {
      // Guards a {2,63} -> {3,63} regex mutation: the negative side ([run:ab] -> null)
      // alone would not catch it; this asserts the inclusive minimum is valid.
      assert.strictEqual(extractRunTag('[run:abc] x'), 'abc');
      assert.strictEqual(extractRunTag('[run:0a1] x'), '0a1'); // leading-digit 3-char
    });

    it('should accept the exact 64-char maximum-length token, and reject 65 (inclusive/exclusive boundary)', () => {
      // Total length is 1 (lead char) + {2,63} = 3..64. An over-long token is
      // DROPPED (extractRunTag returns null), not truncated.
      const token64 = 'a'.repeat(64);
      const token65 = 'a'.repeat(65);
      assert.strictEqual(extractRunTag(`[run:${token64}] x`), token64);
      assert.strictEqual(extractRunTag(`[run:${token65}] x`), null);
    });

    it('should lowercase the result', () => {
      assert.strictEqual(extractRunTag('[RUN:Proj-IR-3-A4F3] x'), 'proj-ir-3-a4f3');
    });

    it('should be line-safe: stop at the first ] and never capture ]/newline/control chars', () => {
      // The token stops at the first ']' — the trailing 'token]' is not part of it.
      assert.strictEqual(extractRunTag('[run:bad]token] rest'), 'bad');
      const captures = [
        extractRunTag('[run:agent-metrics-ir-4625f30d-01] work'),
        extractRunTag('[run:bad]token]'),
        extractRunTag('[RUN:Proj-IR-3-A4F3] x'),
      ];
      for (const cap of captures) {
        if (cap === null) continue;
        assert.ok(!cap.includes(']'), `captured value must not contain ]: ${cap}`);
        assert.ok(!/[\n\r]/.test(cap), `captured value must not contain newline: ${cap}`);
        assert.ok(!/[\x00-\x1f\x7f]/.test(cap), `captured value must not contain control char: ${cap}`);
      }
    });
  });

  describe('sanitizeLineSafe', () => {
    it('should strip control characters and cap length at 64', () => {
      assert.strictEqual(sanitizeLineSafe('abc\ndef'), 'abcdef');
      assert.strictEqual(sanitizeLineSafe('a\x00b\x7fc'), 'abc');
      assert.strictEqual(sanitizeLineSafe('x'.repeat(100)).length, 64);
    });
  });

  describe('detectRunToken', () => {
    it('should detect a [run:token] tag in the first user message', async () => {
      const filePath = createTestTranscript('[agent:executor] [run:proj-ir-4625f30d-01] go', 'runtok');
      assert.strictEqual(await detectRunToken(filePath), 'proj-ir-4625f30d-01');
    });

    it('should return null when no run tag is present', async () => {
      const filePath = createTestTranscript('[agent:executor] no run tag', 'runtok');
      assert.strictEqual(await detectRunToken(filePath), null);
    });

    it('should return null for a non-existent file', async () => {
      assert.strictEqual(await detectRunToken('/non/existent/file.jsonl'), null);
    });
  });

  describe('getFirstUserMessageContent', () => {
    it('should extract first user message content', async () => {
      const filePath = path.join(TEST_DIR, 'user-message.jsonl');
      fs.writeFileSync(filePath, JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Hello, test message' },
      }) + '\n');

      const result = await getFirstUserMessageContent(filePath);
      assert.strictEqual(result, 'Hello, test message');
    });

    it('should return null for non-existent file', async () => {
      const result = await getFirstUserMessageContent('/non/existent/file.jsonl');
      assert.strictEqual(result, null);
    });

    it('should return null for file without user message', async () => {
      const filePath = path.join(TEST_DIR, 'no-user.jsonl');
      fs.writeFileSync(filePath, JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'I am assistant' },
      }) + '\n');

      const result = await getFirstUserMessageContent(filePath);
      assert.strictEqual(result, null);
    });

    it('should handle content as array', async () => {
      const filePath = path.join(TEST_DIR, 'array-content-helper.jsonl');
      fs.writeFileSync(filePath, JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Array content' }],
        },
      }) + '\n');

      const result = await getFirstUserMessageContent(filePath);
      assert.ok(result?.includes('Array content'));
    });

    it('should skip malformed JSON lines', async () => {
      const filePath = path.join(TEST_DIR, 'malformed-then-valid.jsonl');
      fs.writeFileSync(filePath,
        'not valid json\n' +
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'Valid message' } }) + '\n'
      );

      const result = await getFirstUserMessageContent(filePath);
      assert.strictEqual(result, 'Valid message');
    });

    it('should expand ~ in path', async () => {
      // This test just verifies the function doesn't crash with ~ paths
      // Actual expansion depends on HOME env var
      const result = await getFirstUserMessageContent('~/non-existent-file.jsonl');
      assert.strictEqual(result, null);
    });

    describe('issue 192c1f24: a read failure must be distinguishable from "no tag"', () => {
      const TEST_LOG_PATH = path.join(TEST_DIR, 'af-read-failure.log');
      let originalLoggerConfig: ReturnType<typeof getLoggerConfig>;

      beforeEach(() => {
        originalLoggerConfig = getLoggerConfig();
        configureLogger({ logPath: TEST_LOG_PATH, enabled: true, minLevel: 'warn' });
        try { fs.unlinkSync(TEST_LOG_PATH); } catch { /* no-op */ }
      });

      afterEach(() => {
        configureLogger(originalLoggerConfig);
      });

      it('(a) a path that exists but errors on read returns null AND logs a warn entry naming the path', async () => {
        // A directory in place of a file: existsSync is true, but the read
        // itself fails (EISDIR) — the case this fix makes distinguishable
        // from "no [agent:] tag in this transcript".
        const dirPath = path.join(TEST_DIR, 'af-read-failure-dir.jsonl');
        fs.mkdirSync(dirPath, { recursive: true });

        const result = await getFirstUserMessageContent(dirPath);
        assert.strictEqual(result, null);

        const logLines = readRecentLogs(20);
        const warnLine = logLines.find(line => /Failed to read transcript/.test(line));
        assert.ok(warnLine, `Expected a "Failed to read transcript" warn entry, got:\n${logLines.join('\n')}`);
        assert.ok(warnLine.includes(dirPath), `Warn entry should name the transcript path:\n${warnLine}`);
      });

      it('(b) NEGATIVE: a clean transcript with no [agent:] tag returns null and logs NO warn line', async () => {
        const filePath = path.join(TEST_DIR, 'af-read-failure-clean.jsonl');
        fs.writeFileSync(filePath, JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: 'no user message here' },
        }) + '\n');

        const result = await getFirstUserMessageContent(filePath);
        assert.strictEqual(result, null);

        const logLines = readRecentLogs(20);
        assert.ok(
          !logLines.some(line => /Failed to read transcript/.test(line)),
          `A clean read must not log a read-failure warning, got:\n${logLines.join('\n')}`
        );
      });
    });

    describe('issue 20c11894: a well-formed JSONL `null` line must not be reported as malformed', () => {
      const TEST_LOG_PATH = path.join(TEST_DIR, 'af-null-line.log');
      let originalLoggerConfig: ReturnType<typeof getLoggerConfig>;

      beforeEach(() => {
        originalLoggerConfig = getLoggerConfig();
        configureLogger({ logPath: TEST_LOG_PATH, enabled: true, minLevel: 'warn' });
        try { fs.unlinkSync(TEST_LOG_PATH); } catch { /* no-op */ }
      });

      afterEach(() => {
        configureLogger(originalLoggerConfig);
      });

      it('a leading literal `null` JSONL line is skipped without being counted as malformed', async () => {
        const filePath = path.join(TEST_DIR, 'af-null-line.jsonl');
        const validUserLine = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'Valid message after a null line' },
        });
        fs.writeFileSync(filePath, 'null\n' + validUserLine + '\n');

        const result = await getFirstUserMessageContent(filePath);
        assert.strictEqual(result, 'Valid message after a null line');

        const logLines = readRecentLogs(20);
        assert.ok(
          !logLines.some(line => /Skipped malformed transcript lines/.test(line)),
          `A well-formed null line must not be reported as malformed, got:\n${logLines.join('\n')}`
        );
      });

      it('control: a genuinely malformed (non-JSON) line still produces the malformed-line warning', async () => {
        const filePath = path.join(TEST_DIR, 'af-still-malformed.jsonl');
        const validUserLine = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'Valid message after garbage' },
        });
        fs.writeFileSync(filePath, 'not valid json\n' + validUserLine + '\n');

        const result = await getFirstUserMessageContent(filePath);
        assert.strictEqual(result, 'Valid message after garbage');

        const logLines = readRecentLogs(20);
        const warnLine = logLines.find(line => /Skipped malformed transcript lines/.test(line));
        assert.ok(warnLine, `Expected the malformed-line warning to still fire, got:\n${logLines.join('\n')}`);
        assert.ok(warnLine.includes('"skipped_line_count":1'), `Expected skipped_line_count 1, got:\n${warnLine}`);
      });
    });
  });

  describe('readStdin', () => {
    it('returns full payload when two chunks arrive with a >100ms gap before end', async () => {
      // Two chunks separated by a 150ms delay — the old fixed timer would have
      // fired after 100ms, discarding the second chunk. The idle timer must
      // reschedule on each chunk so resolution waits for 'end'.
      const readable = new Readable({ read() {} });

      const promise = readStdin(readable);

      readable.push('{"part":');
      await new Promise(r => setTimeout(r, 150));
      readable.push('"one"}');
      readable.push(null); // EOF

      const result = await promise;
      assert.strictEqual(result, '{"part":"one"}', 'Full payload must be returned despite the inter-chunk gap');
    });

    it('resolves to {} for empty stdin', async () => {
      const readable = new Readable({ read() {} });
      const promise = readStdin(readable);
      readable.push(null); // EOF immediately
      const result = await promise;
      assert.strictEqual(result, '{}', 'Empty stdin must resolve to {}');
    });

    it('issue a88c98d7: resolves with the partial payload once the hard deadline fires, instead of hanging on a stalled partial write', async () => {
      const readable = new Readable({ read() {} });

      // Small injected deadline (default parameter) so the test doesn't wait
      // the real 5000ms ceiling. A partial chunk arrives and the stream never
      // ends, never errors, and sends no further chunks — the idle timer
      // would keep rescheduling on the first chunk and then just sit, since
      // it only fires while `data === ''`.
      const promise = readStdin(readable, 50);

      readable.push('{"part":"stalled');
      // Deliberately no readable.push(null) — the peer stalls mid-write.

      const start = Date.now();
      const result = await promise;
      const elapsed = Date.now() - start;

      assert.strictEqual(result, '{"part":"stalled', 'Should resolve with whatever partial data had accumulated');
      assert.ok(elapsed < 1000, `Should resolve near the injected 50ms deadline, took ${elapsed}ms`);

      readable.destroy();
    });

    describe('issue 338d6bba: stdin cap bounds memory, not just resolution latency', () => {
      // Mirrors src/hook.ts's MAX_STDIN_BYTES (not exported).
      const MAX_STDIN_BYTES = 1 * 1024 * 1024;
      let originalWrite: typeof process.stderr.write;
      let stderrChunks: string[];

      beforeEach(() => {
        stderrChunks = [];
        originalWrite = process.stderr.write;
        process.stderr.write = ((msg: string | Uint8Array) => {
          stderrChunks.push(typeof msg === 'string' ? msg : msg.toString());
          return true;
        }) as typeof process.stderr.write;
      });

      afterEach(() => {
        process.stderr.write = originalWrite;
      });

      it('emits the cap diagnostic exactly once even when ~20 more chunks arrive after the cap fires', async () => {
        const readable = new Readable({ read() {} });
        const promise = readStdin(readable);

        // One chunk that alone exceeds the cap.
        readable.push(Buffer.alloc(MAX_STDIN_BYTES + 1024, 'a'));
        // ~20 more chunks after the cap has already fired — proxy for the
        // unbounded accumulation: each one used to still run `data += chunk`
        // and re-scan Buffer.byteLength(data) over an ever-growing string.
        for (let i = 0; i < 20; i++) {
          readable.push('more data after the cap fired');
        }
        readable.push(null);

        const result = await promise;
        assert.strictEqual(result, '{}', 'Cap must discard the payload');

        const capMessages = stderrChunks.filter((c) => c.includes('stdin exceeded') && c.includes('discarding payload'));
        assert.strictEqual(capMessages.length, 1, `Cap diagnostic must fire exactly once, got:\n${stderrChunks.join('')}`);

        readable.destroy();
      });

      it('control: a payload just under the cap, split across several chunks, resolves intact with no cap diagnostic', async () => {
        const readable = new Readable({ read() {} });
        const promise = readStdin(readable);

        const payloadSize = MAX_STDIN_BYTES - 1024;
        const chunkSize = 100_000;
        const value = 'x'.repeat(payloadSize - 2); // minus the JSON quotes
        const fullPayload = `"${value}"`;

        for (let offset = 0; offset < fullPayload.length; offset += chunkSize) {
          readable.push(fullPayload.slice(offset, offset + chunkSize));
        }
        readable.push(null);

        const result = await promise;
        assert.strictEqual(result, fullPayload, 'Full payload under the cap must be returned intact');
        assert.strictEqual(Buffer.byteLength(result), payloadSize);

        const capMessages = stderrChunks.filter((c) => c.includes('stdin exceeded'));
        assert.strictEqual(capMessages.length, 0, 'No cap diagnostic should fire for a payload under the cap');
      });
    });
  });

  describe('handleHook single-read of the first user message', () => {
    // The transcript must live under ~/.claude/ to pass handleHook's path guard.
    const CLAUDE_DIR = path.join(os.homedir(), '.claude');
    const HOOK_TEST_DIR = path.join(CLAUDE_DIR, `agent-metrics-hooktest-${Date.now()}`);
    // A distinctive, collision-unlikely hex id so the afterEach cleanup targets
    // ONLY this test's entry in the real (default-path) buffer.
    const TEST_AGENT_ID = 'deadbeefcafe1234deadbeefcafe1234';

    before(() => {
      fs.mkdirSync(HOOK_TEST_DIR, { recursive: true });
    });

    after(() => {
      fs.rmSync(HOOK_TEST_DIR, { recursive: true, force: true });
    });

    // handleHook writes one entry to the real default buffer; remove exactly it.
    afterEach(async () => {
      const { clearAgents } = await import('./buffer.js');
      clearAgents([TEST_AGENT_ID]);
    });

    function writeValidTranscript(): string {
      const filePath = path.join(HOOK_TEST_DIR, `agent-${TEST_AGENT_ID}.jsonl`);
      const base = Date.now();
      const common = {
        cwd: '/test/project',
        sessionId: 'sess-hooktest',
        version: '2.1.0',
        gitBranch: 'main',
        agentId: TEST_AGENT_ID,
      };
      const lines = [
        JSON.stringify({
          ...common,
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'kick off' }] },
          uuid: 'u1',
          timestamp: new Date(base).toISOString(),
        }),
        JSON.stringify({
          ...common,
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            model: 'claude-sonnet-4-5-20250929',
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          uuid: 'u2',
          timestamp: new Date(base + 1000).toISOString(),
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n') + '\n');
      return filePath;
    }

    it('reads the first user message EXACTLY once despite extracting both name and run token', async () => {
      const filePath = writeValidTranscript();

      let readCount = 0;
      const countingReader = async (p: string): Promise<string | null> => {
        readCount++;
        // Return a first message carrying BOTH tags — the read that would have
        // been duplicated if name and run-token were resolved via two separate
        // detect*() calls instead of the single-read form.
        return '[agent:executor] [run:proj-ir-4625f30d-01] go';
      };

      const output = await handleHook(
        { agent_transcript_path: filePath, agent_id: TEST_AGENT_ID, cwd: '/test/project' },
        { readFirstMessage: countingReader }
      );

      assert.strictEqual(output.decision, 'approve');
      assert.strictEqual(readCount, 1, 'first user message must be read exactly once for both name + run token');

      // Verify the OBSERVABLE result of the single read: both the agent name AND
      // the run token extracted from that one message were actually persisted to
      // the buffer. Guards the wiring mutation `runId: runId || undefined` ->
      // `runId: undefined` in handleHook's appendToBuffer call, which the
      // read-count assertion alone would not catch.
      const { readBuffer } = await import('./buffer.js');
      const mine = readBuffer().find((e) => e.agent_id === TEST_AGENT_ID);
      assert.ok(mine, 'handleHook must have written a buffer entry for the agent');
      assert.strictEqual(mine.run_id, 'proj-ir-4625f30d-01', 'run token from the single read must be persisted as run_id');
      assert.strictEqual(mine.agent_name, 'executor', 'agent name from the single read must be persisted');
    });

    it('Fix 6: a 64-char run token round-trips intact into the persisted run_id', async () => {
      const filePath = writeValidTranscript();
      const token64 = 'a'.repeat(64);

      const output = await handleHook(
        { agent_transcript_path: filePath, agent_id: TEST_AGENT_ID, cwd: '/test/project' },
        { readFirstMessage: async () => `[agent:executor] [run:${token64}] go` }
      );

      assert.strictEqual(output.decision, 'approve');
      const { readBuffer } = await import('./buffer.js');
      const mine = readBuffer().find((e) => e.agent_id === TEST_AGENT_ID);
      assert.ok(mine, 'handleHook must have written a buffer entry for the agent');
      assert.strictEqual(mine.run_id, token64, 'a 64-char run token must round-trip intact, not be truncated or dropped');
    });

    it('Fix 6: a 65-char run token is dropped (run_id undefined), not silently truncated', async () => {
      const filePath = writeValidTranscript();
      const token65 = 'a'.repeat(65);

      const output = await handleHook(
        { agent_transcript_path: filePath, agent_id: TEST_AGENT_ID, cwd: '/test/project' },
        { readFirstMessage: async () => `[agent:executor] [run:${token65}] go` }
      );

      assert.strictEqual(output.decision, 'approve');
      const { readBuffer } = await import('./buffer.js');
      const mine = readBuffer().find((e) => e.agent_id === TEST_AGENT_ID);
      assert.ok(mine, 'handleHook must have written a buffer entry for the agent');
      assert.strictEqual(mine.run_id, undefined, 'an over-long run token must be dropped, not silently truncated to 64 chars');
    });

    it('issue c3234628: suppresses the capture-success summary when appendToBuffer returns null (lock contention)', async () => {
      const filePath = writeValidTranscript();

      const nullAppend = (() => null) as unknown as typeof import('./buffer.js').appendToBuffer;

      const originalWrite = process.stderr.write;
      let captured = '';
      process.stderr.write = ((msg: string | Uint8Array) => {
        captured += typeof msg === 'string' ? msg : msg.toString();
        return true;
      }) as typeof process.stderr.write;

      let output;
      try {
        output = await handleHook(
          { agent_transcript_path: filePath, agent_id: TEST_AGENT_ID, cwd: '/test/project' },
          { appendToBuffer: nullAppend }
        );
      } finally {
        process.stderr.write = originalWrite;
      }

      assert.strictEqual(output.decision, 'approve', 'must still approve even when the capture is skipped');
      assert.ok(
        !/\[.*\] .* \| .* \| .*k tokens \| .*/.test(captured),
        `capture-success summary line must not be emitted when appendToBuffer returns null, got: ${captured}`,
      );
    });

    it('control: a non-null appendToBuffer return still emits the capture-success summary', async () => {
      const filePath = writeValidTranscript();

      const originalWrite = process.stderr.write;
      let captured = '';
      process.stderr.write = ((msg: string | Uint8Array) => {
        captured += typeof msg === 'string' ? msg : msg.toString();
        return true;
      }) as typeof process.stderr.write;

      let output;
      try {
        output = await handleHook(
          { agent_transcript_path: filePath, agent_id: TEST_AGENT_ID, cwd: '/test/project' },
        );
      } finally {
        process.stderr.write = originalWrite;
      }

      assert.strictEqual(output.decision, 'approve');
      assert.ok(
        /\[.*\] .* \| .* \| .*k tokens \| .*/.test(captured),
        `capture-success summary line should be emitted on a real (non-null) append, got: ${captured}`,
      );
      // afterEach above clears TEST_AGENT_ID from the real buffer this wrote to.
    });
  });
});
