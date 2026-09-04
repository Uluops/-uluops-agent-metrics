#!/usr/bin/env node
/**
 * Guards against test artifacts (dist/**\/*.test.*, dist/test-utils.*) shipping
 * inside the published tarball.
 *
 * package.json's `files` field negations (`!dist/**\/*.test.*`,
 * `!dist/test-utils.*`) are, as of this writing, the SOLE guard against this —
 * a root `files` field makes npm ignore `.npmignore` entirely, so that file is
 * dead as a safety net. This script verifies the negations actually work by
 * inspecting `npm pack --dry-run`'s real file list, not by re-reading the
 * config that produces it.
 *
 * Run via `npm run check:pack` (wired into `prepublishOnly`, after `build`,
 * so it inspects the same dist/ that would actually be packed).
 *
 * --control: intentionally treats an INVERTED assertion as the pass condition,
 * to prove the check can fail against the current (clean) dist/. Do not use
 * this flag for a real gate — it always exits 1 on a clean tree by design.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const isControl = process.argv.includes('--control');

const MIN_FILE_COUNT = 40;
const FORBIDDEN_PATTERNS = [/\.test\./, /test-utils/];

let raw;
try {
  raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: repoRoot, encoding: 'utf-8' });
} catch (err) {
  console.error('FAIL: `npm pack --dry-run --json` failed to run:', err.message);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  console.error('FAIL: could not parse `npm pack --dry-run --json` output as JSON');
  process.exit(1);
}

const files = parsed?.[0]?.files;
if (!Array.isArray(files) || files.length === 0) {
  console.error('FAIL: `npm pack --dry-run` reported an empty or missing file list — the check itself is broken');
  process.exit(1);
}

if (files.length < MIN_FILE_COUNT) {
  console.error(`FAIL: packed file list has only ${files.length} entries, expected >= ${MIN_FILE_COUNT} — the check itself may be broken`);
  process.exit(1);
}

const offenders = files
  .map((f) => f.path)
  .filter((p) => FORBIDDEN_PATTERNS.some((re) => re.test(p)));

if (isControl) {
  // Prove the check can fail: report success only if it WOULD have failed.
  if (offenders.length > 0) {
    console.log(`--control: found ${offenders.length} offending path(s) as expected — check CAN fail.`);
    process.exit(0);
  }
  console.error('--control: found ZERO offending paths on the current tree — remove the files field negations to see this catch something, or this control is not exercising the check.');
  process.exit(1);
}

if (offenders.length > 0) {
  console.error(`FAIL: ${offenders.length} test artifact(s) would be published:`);
  for (const p of offenders) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`OK: ${files.length} files would be packed, none match a test-artifact pattern.`);
process.exit(0);
