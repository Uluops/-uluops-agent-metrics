/**
 * Definition capture: which agent definition (version, content hash) a subagent ran.
 *
 * Definition-version-dispositions checklist X4-1 (uluops-specifications, checklist
 * v0.12.6). The tracker credits a run to an agent version only when the caller sends
 * that agent's own `definition_version`; when it is absent the server stores the latest
 * published version as `inferred-latest`, which no version record counts. Orchestrating
 * models forget, or copy the pipeline's version onto every agent (tracker c18f1ab1), so
 * the version is captured here, deterministically, and travels with the token metrics
 * the orchestrator is already required to splice verbatim.
 *
 * ## When to read the file (X4-0)
 *
 * Claude Code loads a subagent's full definition **when it is spawned**, and watches the
 * agent directories, reloading within seconds (code.claude.com `sub-agents`). A read at
 * SubagentStop is therefore wrong whenever the definition is reinstalled between spawn
 * and stop — routine in this workspace, where crews run for minutes while definitions
 * are regenerated. So the definition is captured at spawn (`PreToolUse` on the agent
 * tool) and checked again at stop:
 *  - same content hash → the spawn capture stands;
 *  - different hash → the definition changed mid-run: omitted (`changed-during-run`);
 *  - modified within {@link RELOAD_WINDOW_MS} before spawn → the watcher may not have
 *    reloaded it yet, so which copy ran is unknown: omitted (`reload-window`).
 *
 * ## Never guess
 *
 * Every path that cannot name the definition that ran omits the version and records a
 * cause. A missing version costs one run's attribution (`inferred-latest`, counted); a
 * wrong one credits another version's record silently.
 *
 * Precedence follows the documented order, project `.claude/agents` (closest to the
 * working directory first) over `~/.claude/agents`. Plugin-scoped agent types
 * (`plugin:name`) are not resolved: the marketplace cache holds plugins that are not
 * installed, so a scan would invent candidates. That is a stated limit (`plugin-scoped`).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Edits closer than this to the spawn may not have been reloaded by Claude Code's watcher. */
export const RELOAD_WINDOW_MS = 30_000;

export type UnresolvedCause =
  | 'no-file'
  | 'no-version'
  | 'ambiguous'
  | 'plugin-scoped'
  | 'changed-during-run'
  | 'reload-window'
  | 'tag-mismatch'
  | 'no-agent-type'
  | 'unverified-at-stop';

export interface DefinitionCapture {
  /** Frontmatter `name` of the definition that ran (the registry name). */
  name: string;
  version: string | null;
  sha256: string;
  path: string;
  mtimeMs: number;
}

export type Resolution =
  | { ok: true; definition: DefinitionCapture; shadowed: string[] }
  | { ok: false; cause: UnresolvedCause; candidates: string[] };

/** One directory to search, in precedence order (index 0 wins). */
export interface DefinitionDir {
  path: string;
  label: string;
}

/**
 * The documented search order: each `.claude/agents` from `cwd` up to (not including)
 * the home directory, closest first, then `~/.claude/agents`.
 */
export function defaultDefinitionDirs(cwd: string | undefined, home: string = os.homedir()): DefinitionDir[] {
  const dirs: DefinitionDir[] = [];
  if (cwd) {
    let dir = path.resolve(cwd);
    const stop = path.resolve(home);
    while (dir !== stop && dir !== path.dirname(dir)) {
      dirs.push({ path: path.join(dir, '.claude', 'agents'), label: `project:${dir}` });
      dir = path.dirname(dir);
    }
  }
  dirs.push({ path: path.join(home, '.claude', 'agents'), label: 'user' });
  return dirs;
}

/**
 * The frontmatter's top-level `name` and `version`, read without a YAML dependency.
 * Only plain scalars on one line are recognized (`version: "1.2.0"` / `version: 1.2.0`),
 * which is what the definition factory renders; anything else reads as absent, and the
 * caller omits rather than guesses.
 */
export function readFrontmatter(text: string): { name?: string; version?: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const out: { name?: string; version?: string } = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '---') break;
    const m = /^(name|version):\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value !== '' && !/[\[{]/.test(value)) out[m[1] as 'name' | 'version'] = value;
  }
  return out;
}

export function captureFile(file: string): DefinitionCapture | null {
  let text: string;
  let stat: fs.Stats;
  try {
    text = fs.readFileSync(file, 'utf8');
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const fm = readFrontmatter(text);
  if (!fm.name) return null;
  return {
    name: fm.name,
    version: fm.version ?? null,
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
    path: file,
    mtimeMs: stat.mtimeMs,
  };
}

/** Every definition file in `dir` whose frontmatter `name` is `agentType`. */
function matchesIn(dir: string, agentType: string): DefinitionCapture[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  } catch {
    return [];
  }
  return entries
    .map(f => captureFile(path.join(dir, f)))
    .filter((c): c is DefinitionCapture => c !== null && c.name === agentType);
}

/** Resolve an agent type to the definition Claude Code would load for it. */
export function resolveDefinition(agentType: string | null | undefined, dirs: readonly DefinitionDir[]): Resolution {
  if (!agentType) return { ok: false, cause: 'no-agent-type', candidates: [] };
  if (agentType.includes(':')) return { ok: false, cause: 'plugin-scoped', candidates: [] };

  for (let i = 0; i < dirs.length; i++) {
    const found = matchesIn(dirs[i]!.path, agentType);
    if (found.length === 0) continue;
    const shadowed = dirs.slice(i + 1).flatMap(d => matchesIn(d.path, agentType).map(c => c.path));
    const versions = new Set(found.map(c => c.version));
    if (versions.size > 1) return { ok: false, cause: 'ambiguous', candidates: found.map(c => c.path) };
    const [first] = found;
    if (first!.version === null) return { ok: false, cause: 'no-version', candidates: found.map(c => c.path) };
    if (found.length > 1) {
      // Same version label in several same-level files: the version is known, the
      // exact content is not — keep the label, drop the hash rather than pick one.
      // The newest mtime stands for the set, so the reload-window checks see any edit.
      const mtimeMs = Math.max(...found.map(c => c.mtimeMs));
      return { ok: true, definition: { ...first!, sha256: '', path: found.map(c => c.path).join(' | '), mtimeMs }, shadowed };
    }
    return { ok: true, definition: first!, shadowed };
  }
  return { ok: false, cause: 'no-file', candidates: [] };
}

/**
 * The spawn-time capture checked at stop (X4-1). `spawn` is what SubagentStart recorded;
 * `atStop` is a fresh resolution of the same agent type.
 *
 * With no spawn record, a stop-time read names the definition that ran only if the file
 * was already settled when the agent started: modified no later than
 * {@link RELOAD_WINDOW_MS} before `startedAtMs` (the transcript's first timestamp).
 * Otherwise the file may have been reinstalled while the agent ran, and the stop-time
 * read would credit the new version for a run of the old one — omitted as
 * `unverified-at-stop`. Until the review of 2026-10-04 (anxiety-reader F1) the stop-time
 * read was accepted unconditionally, which is exactly the stop-read the spawn capture
 * exists to replace.
 */
export function confirmAtStop(
  spawn: { definition: DefinitionCapture; spawnedAtMs: number } | null,
  atStop: Resolution,
  startedAtMs?: number,
): { definition: DefinitionCapture | null; cause: UnresolvedCause | null; capturedAt: 'spawn' | 'stop' } {
  if (!spawn) {
    if (!atStop.ok) return { definition: null, cause: atStop.cause, capturedAt: 'stop' };
    const settled = startedAtMs !== undefined && Number.isFinite(startedAtMs)
      && startedAtMs - atStop.definition.mtimeMs >= RELOAD_WINDOW_MS;
    return settled
      ? { definition: atStop.definition, cause: null, capturedAt: 'stop' }
      : { definition: null, cause: 'unverified-at-stop', capturedAt: 'stop' };
  }
  if (spawn.spawnedAtMs - spawn.definition.mtimeMs < RELOAD_WINDOW_MS) {
    return { definition: null, cause: 'reload-window', capturedAt: 'spawn' };
  }
  const now = spawn.definition.path.includes(' | ') ? null : captureFile(spawn.definition.path);
  if (spawn.definition.sha256 !== '' && now?.sha256 !== spawn.definition.sha256) {
    return { definition: null, cause: 'changed-during-run', capturedAt: 'spawn' };
  }
  return { definition: spawn.definition, cause: null, capturedAt: 'spawn' };
}
