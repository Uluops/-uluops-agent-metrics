/**
 * Hook Module Tests
 *
 * Tests for the SubagentStop hook functionality including:
 * - Agent ID validation
 * - Agent name detection from transcripts
 * - Agent ID extraction from file paths
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  isValidAgentId,
  extractAgentIdFromPath,
  detectAgentName,
  extractExplicitAgentTag,
  getFirstUserMessageContent,
  parseHookInput,
  readStdin,
  AGENT_ID_PATTERN,
} from './hook.js';
import { Readable } from 'node:stream';

// Test configuration with isolated temp directory
const TEST_DIR = path.join(os.tmpdir(), 'agent-metrics-hook-test-' + Date.now());

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
    // Helper to create a test transcript file
    function createTestTranscript(userMessage: string): string {
      const filePath = path.join(TEST_DIR, `transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
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
  });
});
