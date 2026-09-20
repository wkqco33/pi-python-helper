import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveInterpreter, runScanProject } from '../src/project/scanner.ts';
import { findProjectRoot, findVenvDir } from '../src/project/root.ts';
import { listTestFiles } from '../src/build/discover.ts';
import { resolveProjectRoot } from '../extensions/shared.ts';

const PYPROJECT = `[project]
name = "demo-pkg"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["requests>=2.31", "Pillow==10.0.0", "missing-dep>=1.0"]

[project.optional-dependencies]
aws = ["boto3>=1.34"]

[dependency-groups]
dev = ["pytest>=8", "ruff>=0.6"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.ruff]
line-length = 100

[tool.pytest.ini_options]
addopts = "-q"

[tool.uv.workspace]
members = ["packages/a"]
`;

const UV_LOCK = `version = 1
revision = 2
requires-python = ">=3.10"

[[package]]
name = "demo-pkg"
version = "0.1.0"
source = { editable = "." }

[[package]]
name = "requests"
version = "2.30.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "pillow"
version = "10.0.0"
source = { registry = "https://pypi.org/simple" }
`;

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'py-helper-'));
  await mkdir(join(root, 'src', 'demo_pkg'), { recursive: true });
  await mkdir(join(root, 'tests'), { recursive: true });
  await writeFile(join(root, 'pyproject.toml'), PYPROJECT);
  await writeFile(join(root, 'uv.lock'), UV_LOCK);
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  await writeFile(
    join(root, 'src', 'demo_pkg', '__init__.py'),
    'import os\nfrom PIL import Image\n',
  );
  await writeFile(
    join(root, 'src', 'demo_pkg', 'frame.py'),
    'from typing import TYPE_CHECKING\nimport json\n\nif TYPE_CHECKING:\n    import pandas\n',
  );
  await writeFile(join(root, 'tests', 'test_frame.py'), 'import demo_pkg\n');
  return root;
}

test('the scanner reports manifest, lock drift, and import classification', async (t) => {
  const interpreter = await resolveInterpreter(process.cwd());
  if (!interpreter) {
    t.skip('no Python 3 interpreter available');
    return;
  }
  const root = await createProject();
  try {
    const scan = await runScanProject(process.cwd(), { root, mode: 'all' });
    assert.equal(scan.ok, true, scan.message ?? 'scanner failed');
    const payload = scan.payload;
    assert.ok(payload);

    assert.equal(payload.manifest?.name, 'demo-pkg');
    assert.equal(payload.manifest?.requiresPython, '>=3.11');
    assert.equal(payload.manifest?.layout, 'src');
    assert.deepEqual(payload.manifest?.modules, ['demo_pkg']);
    assert.equal(payload.manifest?.importName, 'demo_pkg');
    assert.deepEqual(payload.manifest?.uvWorkspaceMembers, ['packages/a']);
    assert.equal(payload.manifest?.toolConfiguration.ruff, true);
    assert.equal(payload.manifest?.toolConfiguration.mypy, false);

    assert.equal(payload.lock?.present, true);
    assert.ok(payload.lockComparison?.missingFromLock.includes('missing-dep'));
    assert.deepEqual(payload.lockComparison?.requiresPythonMismatch, {
      manifest: '>=3.11',
      lock: '>=3.10',
    });

    // Constraint comparison needs the `packaging` library in the analysing
    // interpreter. Assert the strong result when it is present and the explicit
    // degradation when it is not, so the test does not depend on an optional
    // package being installed in the host environment.
    if (payload.lockComparison?.specifierCheckAvailable) {
      assert.deepEqual(payload.lockComparison.unsatisfiedInLock, [
        { name: 'requests', specifier: '>=2.31', locked: '2.30.0' },
      ]);
    } else {
      assert.deepEqual(payload.lockComparison?.unsatisfiedInLock, []);
      assert.equal(payload.lockComparison?.checkedCount, 4);
    }

    const imports = payload.imports;
    assert.ok(imports);
    assert.equal(imports.stdlibAvailable, true);
    assert.ok(imports.localModules.includes('demo_pkg'));

    const byImport = new Map(imports.thirdParty.map((entry) => [entry.import, entry]));
    assert.equal(byImport.get('PIL')?.typeCheckingOnly, false);
    assert.equal(byImport.get('pandas')?.typeCheckingOnly, true);
    // `os`/`json` are standard library and must never appear as third-party.
    assert.equal(byImport.has('os'), false);
    assert.equal(byImport.has('json'), false);

    const frameFile = imports.files.find((entry) => entry.path.endsWith('frame.py'));
    assert.deepEqual(frameFile?.typeCheckingImports, ['pandas']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the scanner describes the interpreter that runs it', async (t) => {
  const interpreter = await resolveInterpreter(process.cwd());
  if (!interpreter) {
    t.skip('no Python 3 interpreter available');
    return;
  }
  const scan = await runScanProject(process.cwd(), {
    root: process.cwd(),
    mode: 'environment',
  });
  assert.equal(scan.ok, true, scan.message ?? 'scanner failed');
  const environment = scan.payload?.environment;
  assert.ok(environment, 'the scanner must describe its interpreter');
  assert.ok(environment.version.startsWith('3.'));
  assert.equal(typeof environment.executable, 'string');
  assert.ok(environment.implementation.length > 0);
});

test('the scanner reports a broken file instead of failing the whole scan', async (t) => {
  const interpreter = await resolveInterpreter(process.cwd());
  if (!interpreter) {
    t.skip('no Python 3 interpreter available');
    return;
  }
  const root = await createProject();
  try {
    await writeFile(join(root, 'src', 'demo_pkg', 'broken.py'), 'def broken(:\n');
    const scan = await runScanProject(process.cwd(), { root, mode: 'imports' });
    assert.equal(scan.ok, true, scan.message ?? 'scanner failed');
    const unparsable = scan.payload?.imports?.unparsable ?? [];
    assert.equal(unparsable.length, 1);
    assert.match(unparsable[0].path, /broken\.py$/);
    assert.match(unparsable[0].error, /SyntaxError/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('project root and test discovery resolve from a project subdirectory', async (t) => {
  const interpreter = await resolveInterpreter(process.cwd());
  if (!interpreter) {
    t.skip('no Python 3 interpreter available');
    return;
  }
  const root = await createProject();
  try {
    const nested = join(root, 'src', 'demo_pkg');
    assert.equal(await findProjectRoot(nested), root);
    assert.equal(await findVenvDir(root), undefined);
    assert.equal(await resolveProjectRoot(nested), root);
    assert.equal(await resolveProjectRoot(root, 'pyproject.toml'), root);
    const testFiles = await listTestFiles(root);
    assert.deepEqual(testFiles, ['tests/test_frame.py']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unreadable directory does not abort the scan', async (t) => {
  const interpreter = await resolveInterpreter(process.cwd());
  if (!interpreter) {
    t.skip('no Python 3 interpreter available');
    return;
  }
  const root = await createProject();
  const blocked = join(root, 'blocked-entry');
  try {
    await mkdir(blocked, { recursive: true });
    await writeFile(join(blocked, '__init__.py'), 'x = 1\n');
    await chmod(blocked, 0o000);
    const scan = await runScanProject(process.cwd(), { root, mode: 'all' });
    assert.equal(scan.ok, true, scan.message ?? 'scanner failed');
    // The healthy parts of the project are still reported.
    assert.equal(scan.payload?.manifest?.name, 'demo-pkg');
    assert.ok(scan.payload?.imports?.localModules.includes('demo_pkg'));
  } finally {
    await chmod(blocked, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('the scanner degrades to a structured error outside any project', async (t) => {
  const interpreter = await resolveInterpreter(process.cwd());
  if (!interpreter) {
    t.skip('no Python 3 interpreter available');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'py-empty-'));
  try {
    const scan = await runScanProject(process.cwd(), { root, mode: 'manifest' });
    assert.equal(scan.ok, true, scan.message ?? 'scanner failed');
    assert.equal(scan.payload?.manifest?.pyprojectPath, null);
    assert.equal(scan.payload?.lock?.present, false);
    assert.ok((scan.payload?.manifest?.warnings.length ?? 0) > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
