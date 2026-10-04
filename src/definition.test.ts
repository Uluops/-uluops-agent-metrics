/**
 * Definition capture tests (checklist X4-1). Each case names the naive reference it
 * defeats; the controls are asserted beside the rule.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RELOAD_WINDOW_MS,
  captureFile,
  confirmAtStop,
  defaultDefinitionDirs,
  readFrontmatter,
  resolveDefinition,
  type DefinitionDir,
} from './definition.js';

let root: string;
const def = (name: string, version: string | null, body = 'body'): string =>
  `---\nname: ${name}\n${version === null ? '' : `version: "${version}"\n`}model: opus\n---\n\n${body}\n`;
const write = (dir: string, file: string, text: string): string => {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, file);
  fs.writeFileSync(p, text);
  return p;
};

describe('definition capture (X4-1)', () => {
  let project: string;
  let user: string;
  let dirs: DefinitionDir[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-def-'));
    project = path.join(root, 'proj', '.claude', 'agents');
    user = path.join(root, 'home', '.claude', 'agents');
    dirs = [{ path: project, label: 'project' }, { path: user, label: 'user' }];
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads quoted and bare version scalars; refuses flow values', () => {
    assert.deepStrictEqual(readFrontmatter(def('a', '1.2.0')), { name: 'a', version: '1.2.0' });
    assert.deepStrictEqual(readFrontmatter('---\nname: a\nversion: 2.0.1\n---\n'), { name: 'a', version: '2.0.1' });
    assert.deepStrictEqual(readFrontmatter('---\nname: a\nversion: [1]\n---\n'), { name: 'a' });
    assert.deepStrictEqual(readFrontmatter('no frontmatter\nversion: 1.0.0'), {});
  });

  it('matches by frontmatter name, not file name (code-auditor in code-auditor-agent.md)', () => {
    write(user, 'code-auditor-agent.md', def('code-auditor', '2.7.3'));
    const r = resolveDefinition('code-auditor', dirs);
    assert.ok(r.ok);
    assert.strictEqual(r.definition.version, '2.7.3');
    assert.match(r.definition.sha256, /^[0-9a-f]{64}$/);
  });

  it('project beats user, and the user copy is recorded as shadowed (documented precedence)', () => {
    write(project, 'x.md', def('x', '1.1.0'));
    const u = write(user, 'x-agent.md', def('x', '1.0.0'));
    const r = resolveDefinition('x', dirs);
    assert.ok(r.ok);
    assert.strictEqual(r.definition.version, '1.1.0');
    assert.deepStrictEqual(r.shadowed, [u]);
  });

  it('two same-level files at different versions are ambiguous (control: first match)', () => {
    write(user, 'x-agent.md', def('x', '1.0.0'));
    write(user, 'x-copy.md', def('x', '1.1.0'));
    const r = resolveDefinition('x', dirs);
    assert.deepStrictEqual(r.ok ? 'resolved' : r.cause, 'ambiguous');
    const firstMatch = captureFile(path.join(user, fs.readdirSync(user).sort()[0]!));
    assert.ok(firstMatch?.version); // a first-match reference would have recorded a version
  });

  it('same-level duplicates at the same version keep the label and drop the hash', () => {
    write(user, 'x-agent.md', def('x', '1.0.0', 'one'));
    write(user, 'x-copy.md', def('x', '1.0.0', 'two'));
    const r = resolveDefinition('x', dirs);
    assert.ok(r.ok);
    assert.strictEqual(r.definition.version, '1.0.0');
    assert.strictEqual(r.definition.sha256, '');
  });

  it('no version in frontmatter → omitted (control: a 0.0.0 default)', () => {
    write(user, 'x.md', def('x', null));
    const r = resolveDefinition('x', dirs);
    assert.deepStrictEqual(r.ok ? 'resolved' : r.cause, 'no-version');
  });

  it('no file, no agent type, plugin-scoped → omitted with a cause', () => {
    assert.strictEqual((resolveDefinition('missing', dirs) as { cause: string }).cause, 'no-file');
    assert.strictEqual((resolveDefinition(undefined, dirs) as { cause: string }).cause, 'no-agent-type');
    assert.strictEqual((resolveDefinition('agents:anxiety-reader', dirs) as { cause: string }).cause, 'plugin-scoped');
  });

  it('defaultDefinitionDirs walks from cwd up to home, closest first, then the user dir', () => {
    const home = path.join(root, 'home');
    const cwd = path.join(home, 'a', 'b');
    assert.deepStrictEqual(defaultDefinitionDirs(cwd, home).map(d => d.path), [
      path.join(home, 'a', 'b', '.claude', 'agents'),
      path.join(home, 'a', '.claude', 'agents'),
      path.join(home, '.claude', 'agents'),
    ]);
  });

  describe('confirmAtStop', () => {
    it('unchanged since spawn → the spawn capture stands', () => {
      const p = write(user, 'x.md', def('x', '1.0.0'));
      const spawn = captureFile(p)!;
      const out = confirmAtStop({ definition: spawn, spawnedAtMs: spawn.mtimeMs + RELOAD_WINDOW_MS + 1 }, resolveDefinition('x', dirs));
      assert.strictEqual(out.definition?.version, '1.0.0');
      assert.strictEqual(out.capturedAt, 'spawn');
    });

    it('reinstalled between spawn and stop → omitted (control: a stop-time read records the new version)', () => {
      const p = write(user, 'x.md', def('x', '1.0.0'));
      const spawn = captureFile(p)!;
      fs.writeFileSync(p, def('x', '1.1.0'));
      const atStop = resolveDefinition('x', dirs);
      const out = confirmAtStop({ definition: spawn, spawnedAtMs: spawn.mtimeMs + RELOAD_WINDOW_MS + 1 }, atStop);
      assert.strictEqual(out.definition, null);
      assert.strictEqual(out.cause, 'changed-during-run');
      assert.ok(atStop.ok && atStop.definition.version === '1.1.0'); // the stop-read reference is wrong
    });

    it('modified 5 s before spawn → omitted (inside the watcher\'s reload lag)', () => {
      const p = write(user, 'x.md', def('x', '1.0.0'));
      const spawn = captureFile(p)!;
      const out = confirmAtStop({ definition: spawn, spawnedAtMs: spawn.mtimeMs + 5_000 }, resolveDefinition('x', dirs));
      assert.strictEqual(out.cause, 'reload-window');
    });

    it('no spawn record → a stop-time capture, marked as such', () => {
      write(user, 'x.md', def('x', '1.0.0'));
      const out = confirmAtStop(null, resolveDefinition('x', dirs));
      assert.strictEqual(out.definition?.version, '1.0.0');
      assert.strictEqual(out.capturedAt, 'stop');
    });
  });
});
