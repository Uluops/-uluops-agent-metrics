#!/usr/bin/env node
/**
 * Guards README.md's `@uluops/agent-metrics` import blocks against drifting
 * from src/index.ts's actual public export surface.
 *
 * Extracts the public symbol list from every `export [type] { ... } from`
 * block in src/index.ts (resolving `x as y` to `y`), extracts every symbol
 * from every `import [type] { ... } from '@uluops/agent-metrics'` block in
 * README.md, and fails if the two sets differ:
 *   - a symbol exported but not documented (README is stale/incomplete)
 *   - a symbol documented but not exported (README references something
 *     that doesn't exist, or a stale prose fragment leaked into a code block)
 *
 * --control: drops one symbol from the extracted export list before
 * comparing, to prove the check can actually fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const isControl = process.argv.includes('--control');

function extractBracedSymbols(src, blockRegex) {
  const symbols = [];
  for (const match of src.matchAll(blockRegex)) {
    const inner = match[1];
    // Strip line comments per-line before splitting on commas, so
    // `// Buffer types`-style section headers inside the braces don't
    // get treated as symbols.
    const cleaned = inner
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const raw of cleaned.split(',')) {
      const token = raw.trim();
      if (!token) continue;
      const asMatch = token.match(/as\s+(\S+)\s*$/);
      symbols.push(asMatch ? asMatch[1] : token);
    }
  }
  return symbols;
}

function extractExportedSymbols() {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'index.ts'), 'utf-8');
  const regex = /export\s+(?:type\s+)?\{([^}]*)\}\s*from/gs;
  return new Set(extractBracedSymbols(src, regex));
}

function extractReadmeSymbols() {
  const src = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf-8');
  const regex = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@uluops\/agent-metrics["']/gs;
  return new Set(extractBracedSymbols(src, regex));
}

const exported = extractExportedSymbols();
const documented = extractReadmeSymbols();

if (exported.size === 0) {
  console.error('FAIL: extracted zero exported symbols from src/index.ts — extraction is broken');
  process.exit(1);
}
if (documented.size === 0) {
  console.error('FAIL: extracted zero documented symbols from README.md — extraction is broken');
  process.exit(1);
}

if (isControl) {
  // Deliberately drop one symbol to prove the check can fail.
  const [dropped] = exported;
  exported.delete(dropped);
  console.error(`--control: dropped "${dropped}" from the exported set`);
}

const exportedNotDocumented = [...exported].filter((s) => !documented.has(s)).sort();
const documentedNotExported = [...documented].filter((s) => !exported.has(s)).sort();

if (exportedNotDocumented.length === 0 && documentedNotExported.length === 0) {
  console.log(`OK: README import blocks match src/index.ts's ${exported.size} exported symbols exactly.`);
  process.exit(0);
}

if (exportedNotDocumented.length > 0) {
  console.error('Exported but not documented in README.md:');
  for (const s of exportedNotDocumented) console.error(`  - ${s}`);
}
if (documentedNotExported.length > 0) {
  console.error('Documented in README.md but not exported from src/index.ts:');
  for (const s of documentedNotExported) console.error(`  - ${s}`);
}
process.exit(1);
