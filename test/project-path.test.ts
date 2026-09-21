import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import register from '../extensions/index.ts';

const run = promisify(execFile);

interface RegisteredTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    update: undefined,
    ctx: { cwd: string },
  ) => Promise<{ details?: Record<string, unknown> }>;
}

function loadExtension(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  register({
    registerTool: (tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    },
    registerCommand: () => undefined,
  } as unknown as Parameters<typeof register>[0]);
  return tools;
}

/**
 * A project reached through `path` must be the directory the helper actually
 * runs `uv`/`pytest`/`git` in. Running them in `ctx.cwd` instead makes every
 * path-aware tool silently operate on the wrong directory when the session is
 * not started at the project root.
 */
test('path-aware execution tools run their commands in the targeted project', async () => {
  const session = await mkdtemp(join(tmpdir(), 'py-session-'));
  const project = join(session, 'project');
  await mkdir(join(project, 'src', 'app'), { recursive: true });
  await writeFile(join(project, 'pyproject.toml'), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  await writeFile(join(project, 'src', 'app', 'parser.py'), 'def parse():\n    return 1\n');
  try {
    const tools = loadExtension();
    const invoke = (name: string, params: Record<string, unknown>) => {
      const tool = tools.get(name);
      assert.ok(tool, `${name} must be registered`);
      return tool.execute('id', params, undefined, undefined, { cwd: session });
    };

    for (const [name, params] of [
      ['py_sync', { path: project, execute: false }],
      ['py_test', { path: project, execute: false }],
      ['py_validation_bundle', { path: project, execute: false }],
    ] as const) {
      const details = (await invoke(name, params)).details as {
        data: { command?: { cwd?: string }; steps?: { cwd?: string }[] };
      };
      const commands = details.data.command ? [details.data.command] : (details.data.steps ?? []);
      assert.ok(commands.length > 0, `${name} should return at least one command`);
      for (const command of commands) {
        assert.equal(command.cwd, project, `${name} ran its command outside the project`);
      }
    }
  } finally {
    await rm(session, { recursive: true, force: true });
  }
});

test('py_tdd_checkpoint reads git changes from the targeted project', async () => {
  const session = await mkdtemp(join(tmpdir(), 'py-session-'));
  const project = join(session, 'project');
  await mkdir(join(project, 'src', 'app'), { recursive: true });
  await writeFile(join(project, 'pyproject.toml'), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  const source = join(project, 'src', 'app', 'parser.py');
  await writeFile(source, 'def parse():\n    return 1\n');
  try {
    await run('git', ['init', '-q'], { cwd: project });
    await run('git', ['add', '.'], { cwd: project });
    await run(
      'git',
      ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init'],
      { cwd: project },
    );
    await writeFile(source, 'def parse():\n    return 2\n');

    const tools = loadExtension();
    const tool = tools.get('py_tdd_checkpoint');
    assert.ok(tool);
    const details = (
      await tool.execute('id', { path: project }, undefined, undefined, { cwd: session })
    ).details as { data: { changedPaths: string[]; source: string } };
    // If git ran in the session directory instead of the project, no change
    // would be found and the checkpoint would pass vacuously.
    assert.deepEqual(details.data.changedPaths, ['src/app/parser.py']);
    assert.equal(details.data.source, 'git diff');
  } finally {
    await rm(session, { recursive: true, force: true });
  }
});
