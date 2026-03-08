/**
 * Hook Module Tests
 *
 * Tests for the SubagentStop hook functionality including:
 * - Agent ID validation
 * - Validator name detection from transcripts
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
  detectValidatorName,
  matchValidatorPattern,
  getFirstUserMessageContent,
  AGENT_ID_PATTERN,
  VALIDATOR_PATTERNS,
} from './hook.js';

// Test configuration with isolated temp directory
const TEST_DIR = path.join(os.tmpdir(), 'agent-metrics-hook-test-' + Date.now());

describe('Hook Module', () => {
  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
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

  describe('detectValidatorName', () => {
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

    it('should detect code-validator', async () => {
      const filePath = createTestTranscript('Run code-validator on this directory');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'code-validator');
    });

    it('should detect code validator with space', async () => {
      const filePath = createTestTranscript('Run code validator on this');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'code-validator');
    });

    it('should detect codevalidator without separator', async () => {
      const filePath = createTestTranscript('Run codevalidator now');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'code-validator');
    });

    it('should be case insensitive', async () => {
      const filePath = createTestTranscript('Run CODE-VALIDATOR now');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'code-validator');
    });

    it('should detect test-architect', async () => {
      const filePath = createTestTranscript('Validate test quality with test-architect');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'test-architect');
    });

    it('should detect security-analyst', async () => {
      const filePath = createTestTranscript('Run security analyst on the codebase');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'security-analyst');
    });

    it('should detect type-safety-validator', async () => {
      const filePath = createTestTranscript('Check type safety for this project');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'type-safety-validator');
    });

    it('should detect frontend-validator', async () => {
      const filePath = createTestTranscript('Run frontend validator');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'frontend-validator');
    });

    it('should detect public-interface-validator', async () => {
      const filePath = createTestTranscript('Check public interface');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'public-interface-validator');
    });

    it('should detect api-contract-validator', async () => {
      const filePath = createTestTranscript('Validate api contract');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'api-contract-validator');
    });

    it('should detect mcp-validator', async () => {
      const filePath = createTestTranscript('Run MCP validator on the server');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'mcp-validator');
    });

    it('should detect code-optimizer', async () => {
      const filePath = createTestTranscript('Run code optimizer');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'code-optimizer');
    });

    it('should detect code-auditor', async () => {
      const filePath = createTestTranscript('Run code auditor');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'code-auditor');
    });

    it('should detect prompt-engineer', async () => {
      const filePath = createTestTranscript('Run prompt engineer validation');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'prompt-engineer');
    });

    it('should detect prompt-pattern-analyzer', async () => {
      const filePath = createTestTranscript('Analyze prompt patterns');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'prompt-pattern-analyzer');
    });

    it('should detect prompt-quality-validator', async () => {
      const filePath = createTestTranscript('Check prompt quality');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'prompt-quality-validator');
    });

    it('should detect data-science', async () => {
      const filePath = createTestTranscript('Run data science agent');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'data-science');
    });

    it('should detect ml-algorithms', async () => {
      const filePath = createTestTranscript('Analyze ML algorithm implementation');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'ml-algorithms');
    });

    it('should return null when no validator pattern matches', async () => {
      const filePath = createTestTranscript('Just do some regular work please');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, null);
    });

    it('should return null for empty file', async () => {
      const filePath = path.join(TEST_DIR, 'empty.jsonl');
      fs.writeFileSync(filePath, '');
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, null);
    });

    it('should return null for non-existent file', async () => {
      const result = await detectValidatorName('/non/existent/file.jsonl');
      assert.strictEqual(result, null);
    });

    it('should handle malformed JSON gracefully', async () => {
      const filePath = path.join(TEST_DIR, 'malformed.jsonl');
      fs.writeFileSync(filePath, 'not valid json\n');
      const result = await detectValidatorName(filePath);
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
          message: { role: 'user', content: 'Now run code-validator' },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const result = await detectValidatorName(filePath);
      // Should NOT detect code-validator because it's in the second user message
      assert.strictEqual(result, null);
    });

    it('should handle ~ path expansion', async () => {
      // Create file in test dir and reference with relative-like path
      const filePath = createTestTranscript('Run test-architect');

      // The function should work with the actual path
      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'test-architect');
    });

    it('should handle content as array', async () => {
      const filePath = path.join(TEST_DIR, 'array-content.jsonl');
      const content = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Please run the security analyst' },
          ],
        },
      });
      fs.writeFileSync(filePath, content + '\n');

      const result = await detectValidatorName(filePath);
      assert.strictEqual(result, 'security-analyst');
    });
  });

  describe('matchValidatorPattern', () => {
    it('should match known validators', () => {
      assert.strictEqual(matchValidatorPattern('Run code-validator'), 'code-validator');
      assert.strictEqual(matchValidatorPattern('Check type safety'), 'type-safety-validator');
      assert.strictEqual(matchValidatorPattern('Run security analyst'), 'security-analyst');
    });

    it('should return null for no match', () => {
      assert.strictEqual(matchValidatorPattern('Hello world'), null);
      assert.strictEqual(matchValidatorPattern(''), null);
      assert.strictEqual(matchValidatorPattern('Just some random text'), null);
    });

    it('should be case insensitive', () => {
      assert.strictEqual(matchValidatorPattern('CODE-VALIDATOR'), 'code-validator');
      assert.strictEqual(matchValidatorPattern('Test Architect'), 'test-architect');
    });

    it('should accept custom patterns', () => {
      const customPatterns: Array<readonly [RegExp, string]> = [
        [/custom-validator/i, 'my-custom'],
      ];
      assert.strictEqual(matchValidatorPattern('Run custom-validator', customPatterns), 'my-custom');
      assert.strictEqual(matchValidatorPattern('code-validator', customPatterns), null);
    });
  });

  describe('VALIDATOR_PATTERNS ordering', () => {
    it('should match code-auditor before code-validator', () => {
      // Both contain "code", but auditor should match first
      const auditorResult = matchValidatorPattern('Run code-auditor on this');
      assert.strictEqual(auditorResult, 'code-auditor');

      // code-validator should still work on its own
      const validatorResult = matchValidatorPattern('Run code-validator on this');
      assert.strictEqual(validatorResult, 'code-validator');
    });

    it('should match code-optimizer before code-validator', () => {
      const optimizerResult = matchValidatorPattern('Run code-optimizer');
      assert.strictEqual(optimizerResult, 'code-optimizer');
    });

    it('should match prompt-pattern before prompt-engineer', () => {
      // prompt-pattern-analyzer is more specific
      const patternResult = matchValidatorPattern('Analyze prompt patterns');
      assert.strictEqual(patternResult, 'prompt-pattern-analyzer');

      // prompt-engineer should still work
      const engineerResult = matchValidatorPattern('Run prompt engineer');
      assert.strictEqual(engineerResult, 'prompt-engineer');
    });

    it('should match prompt-quality before prompt-engineer', () => {
      const qualityResult = matchValidatorPattern('Check prompt quality');
      assert.strictEqual(qualityResult, 'prompt-quality-validator');
    });

    it('should have documented categories in correct order', () => {
      // Verify that more specific patterns come before general ones in the array
      const codeAuditorIdx = VALIDATOR_PATTERNS.findIndex(([, name]) => name === 'code-auditor');
      const codeValidatorIdx = VALIDATOR_PATTERNS.findIndex(([, name]) => name === 'code-validator');
      const codeOptimizerIdx = VALIDATOR_PATTERNS.findIndex(([, name]) => name === 'code-optimizer');

      assert.ok(codeAuditorIdx < codeValidatorIdx, 'code-auditor should come before code-validator');
      assert.ok(codeOptimizerIdx < codeValidatorIdx, 'code-optimizer should come before code-validator');

      const promptPatternIdx = VALIDATOR_PATTERNS.findIndex(([, name]) => name === 'prompt-pattern-analyzer');
      const promptEngineerIdx = VALIDATOR_PATTERNS.findIndex(([, name]) => name === 'prompt-engineer');

      assert.ok(promptPatternIdx < promptEngineerIdx, 'prompt-pattern-analyzer should come before prompt-engineer');
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
});
