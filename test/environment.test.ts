import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findVenvScript,
  inspectTools,
  lockedVersions,
  resolveOnPath,
} from '../src/environment/tools.ts';
import { detectPythonEnvironment, toolVersion } from '../src/environment/discovery.ts';
import { resolveInterpreter } from '../src/project/scanner.ts';
import type { LockPackage } from '../src/project/scanner.ts';

async function makeExecutable(path: string): Promise<void> {
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, 0o755);
}

function lockPackage(name: string, version: string): LockPackage {
  return {
    name,
    normalized: name.replace(/[-_.]+/g, '-').toLowerCase(),
    version,
    source: 'registry',
  };
}

test('lockedVersions indexes by normalized distribution name', () => {
  const versions = lockedVersions([
    lockPackage('pytest', '9.1.1'),
    lockPackage('python_dateutil', '2.9.0'),
    { name: 'app', normalized: 'app', version: null, source: 'editable' },
  ]);
  assert.equal(versions.get('pytest'), '9.1.1');
  assert.equal(versions.get('python-dateutil'), '2.9.0');
  assert.equal(versions.has('app'), false);
});

test('findVenvScript locates an executable console script', async () => {
  const venv = await mkdtemp(join(tmpdir(), 'py-tools-'));
  try {
    await mkdir(join(venv, 'bin'), { recursive: true });
    await makeExecutable(join(venv, 'bin', 'pytest'));
    // A non-executable file must not be mistaken for a console script.
    await writeFile(join(venv, 'bin', 'ruff'), 'not executable\n');
    assert.equal(await findVenvScript(venv, 'pytest'), join(venv, 'bin', 'pytest'));
    assert.equal(await findVenvScript(venv, 'ruff'), undefined);
    assert.equal(await findVenvScript(venv, 'mypy'), undefined);
  } finally {
    await rm(venv, { recursive: true, force: true });
  }
});

test('resolveOnPath returns the first matching directory only', async () => {
  const first = await mkdtemp(join(tmpdir(), 'py-path-a-'));
  const second = await mkdtemp(join(tmpdir(), 'py-path-b-'));
  try {
    await makeExecutable(join(second, 'mytool'));
    const value = [first, second].join(':');
    assert.equal(await resolveOnPath('mytool', value), join(second, 'mytool'));
    assert.equal(await resolveOnPath('missing', value), undefined);
    assert.equal(await resolveOnPath('mytool', ''), undefined);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test('a distribution recorded in the lockfile is installable but not available', async () => {
  const tools = await inspectTools({
    lockPackages: [lockPackage('ruff', '0.16.8')],
    names: ['ruff'],
    pathValue: '',
  });
  assert.deepEqual(tools, [
    {
      name: 'ruff',
      // The lockfile says uv sync *could* install it; it does not say it is runnable.
      available: false,
      declared: true,
      installable: true,
      installed: false,
      executable: undefined,
      origin: undefined,
      version: '0.16.8',
      versionSource: 'lock',
      preferredInvocation: 'uv run --frozen ruff',
    },
  ]);
});

test('the project environment takes precedence over PATH and yields the locked version', async () => {
  const venv = await mkdtemp(join(tmpdir(), 'py-tools-venv-'));
  const hostDir = await mkdtemp(join(tmpdir(), 'py-tools-host-'));
  try {
    await mkdir(join(venv, 'bin'), { recursive: true });
    await makeExecutable(join(venv, 'bin', 'pytest'));
    await makeExecutable(join(hostDir, 'pytest'));
    const tools = await inspectTools({
      venvDir: venv,
      lockPackages: [lockPackage('pytest', '9.1.1')],
      names: ['pytest'],
      pathValue: hostDir,
    });
    assert.equal(tools[0].origin, 'venv');
    assert.equal(tools[0].executable, join(venv, 'bin', 'pytest'));
    assert.equal(tools[0].version, '9.1.1');
    assert.equal(tools[0].versionSource, 'lock');
  } finally {
    await rm(venv, { recursive: true, force: true });
    await rm(hostDir, { recursive: true, force: true });
  }
});

test('a host PATH tool is reported without claiming a version', async () => {
  const hostDir = await mkdtemp(join(tmpdir(), 'py-tools-host-'));
  try {
    await makeExecutable(join(hostDir, 'pytest'));
    const tools = await inspectTools({ names: ['pytest'], pathValue: hostDir });
    assert.equal(tools[0].available, true);
    assert.equal(tools[0].declared, false);
    assert.equal(tools[0].origin, 'path');
    assert.equal(tools[0].version, undefined);
    assert.equal(tools[0].versionSource, 'unknown');
  } finally {
    await rm(hostDir, { recursive: true, force: true });
  }
});

test('an absent tool is reported as unavailable', async () => {
  const tools = await inspectTools({ names: ['mypy'], pathValue: '' });
  assert.equal(tools[0].available, false);
  assert.equal(tools[0].declared, false);
  assert.equal(tools[0].origin, undefined);
});

test('py_environment does not spawn one process per project tool', async (t) => {
  if (!(await resolveInterpreter(process.cwd()))) {
    t.skip('no Python 3 interpreter available');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'py-env-'));
  try {
    await mkdir(join(root, '.venv', 'bin'), { recursive: true });
    await mkdir(join(root, 'src', 'app'), { recursive: true });
    await makeExecutable(join(root, '.venv', 'bin', 'ruff'));
    await writeFile(
      join(root, 'pyproject.toml'),
      '[project]\nname = "app"\nversion = "0.1.0"\nrequires-python = ">=3.11"\ndependencies = []\n\n[dependency-groups]\ndev = ["pytest>=8", "ruff>=0.6"]\n',
    );
    await writeFile(
      join(root, 'uv.lock'),
      'version = 1\nrevision = 2\nrequires-python = ">=3.11"\n\n[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { editable = "." }\n\n[[package]]\nname = "pytest"\nversion = "9.1.1"\nsource = { registry = "https://pypi.org/simple" }\n\n[[package]]\nname = "ruff"\nversion = "0.16.8"\nsource = { registry = "https://pypi.org/simple" }\n\n[[package]]\nname = "pre-commit"\nversion = "4.0.1"\nsource = { registry = "https://pypi.org/simple" }\n',
    );
    await writeFile(join(root, 'src', 'app', '__init__.py'), '');

    const environment = await detectPythonEnvironment(root);
    assert.equal(environment.projectRoot, root);
    assert.equal(environment.venvDir, join(root, '.venv'));
    assert.equal(environment.uv.lockPresent, true);

    const byName = new Map(environment.tools.map((tool) => [tool.name, tool]));
    // Locked and present in the project environment.
    assert.equal(byName.get('ruff')?.origin, 'venv');
    assert.equal(byName.get('ruff')?.version, '0.16.8');
    // Locked but not installed here: runnable through uv run, so still available.
    assert.equal(byName.get('pytest')?.declared, true);
    assert.equal(byName.get('pytest')?.version, '9.1.1');
    assert.notEqual(byName.get('pytest')?.origin, 'venv');
    // Locked, not installed here, and absent from this environment's PATH: the
    // environment cannot run it until it is synced again.
    assert.equal(byName.get('pre-commit')?.available, false);
    assert.equal(byName.get('pre-commit')?.declared, true);
    assert.equal(byName.get('pre-commit')?.installable, true);
    assert.equal(byName.get('pre-commit')?.version, '4.0.1');
    // Neither declared nor installed anywhere.
    assert.equal(byName.get('mypy')?.available, false);
    assert.equal(byName.get('mypy')?.installable, false);
    assert.equal(byName.get('mypy')?.versionSource, 'unknown');

    // The project environment exists, so the "no environment" warning is wrong.
    assert.equal(
      environment.warnings.some((entry) => entry.code === 'NO_VIRTUAL_ENVIRONMENT'),
      false,
    );

    // A declared tool with no executable is reported instead of looking healthy.
    assert.equal(
      environment.warnings.some((entry) => entry.code === 'TOOL_NOT_INSTALLED'),
      true,
    );
    assert.match(environment.suggestions.join(' '), /--all-extras/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('py_environment reports a missing project instead of failing', async (t) => {
  if (!(await resolveInterpreter(process.cwd()))) {
    t.skip('no Python 3 interpreter available');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'py-noproj-'));
  try {
    const environment = await detectPythonEnvironment(root);
    assert.ok(environment.warnings.some((entry) => entry.code === 'PROJECT_NOT_FOUND'));
    assert.equal(environment.projectRoot, undefined);
    assert.match(environment.suggestions.join(' '), /uv init/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('toolVersion returns a version for an installed host CLI', async () => {
  const version = await toolVersion(process.cwd(), 'uv');
  if (version === undefined) return; // uv is optional in this environment
  assert.match(version, /^\d+\.\d+/);
  assert.equal(await toolVersion(process.cwd(), 'definitely-not-a-real-cli-xyz'), undefined);
});
