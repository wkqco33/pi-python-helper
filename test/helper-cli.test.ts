import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/core/runner.ts';
import {
  HELPER_URL,
  SUPPORTED_SCANNER_VERSION,
  resolveInterpreter,
} from '../src/project/scanner.ts';

/**
 * The scanner is a stdio protocol helper invoked by the extension, so its CLI
 * surface has to stay predictable: results on stdout, diagnostics on stderr,
 * and distinct exit codes for success, failure, and invalid input.
 */
async function runHelper(
  args: string[],
  stdin = '',
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const interpreter = await resolveInterpreter(process.cwd());
  assert.ok(interpreter, 'a Python 3 interpreter is required for this test');
  const run = await runCommand(interpreter, [HELPER_URL.pathname, ...args], {
    cwd: process.cwd(),
    timeoutMs: 30000,
    maxBytes: 512 * 1024,
    stdin,
    env,
  });
  return { code: run.code, stdout: run.stdout, stderr: run.stderr };
}

async function helperAvailable(): Promise<boolean> {
  return (await resolveInterpreter(process.cwd())) !== undefined;
}

test('--help prints usage to stdout and exits 0', async (t) => {
  if (!(await helperAvailable())) return t.skip('no Python 3 interpreter available');
  const run = await runHelper(['--help']);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /usage: scan_project\.py/);
  assert.match(run.stdout, /exit codes: 0 success, 1 unexpected failure, 2 invalid input/);
  assert.equal(run.stderr, '');
});

test('--version reports the scanner protocol version and exits 0', async (t) => {
  if (!(await helperAvailable())) return t.skip('no Python 3 interpreter available');
  const run = await runHelper(['--version']);
  assert.equal(run.code, 0);
  assert.match(run.stdout, new RegExp(`scanner protocol ${SUPPORTED_SCANNER_VERSION}`));
});

test('an unknown flag exits 2 with usage on stderr', async (t) => {
  if (!(await helperAvailable())) return t.skip('no Python 3 interpreter available');
  const run = await runHelper(['--bogus']);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /usage: scan_project\.py/);
  assert.equal(run.stdout, '');
});

test('invalid request JSON exits 2 with a structured error and a stderr message', async (t) => {
  if (!(await helperAvailable())) return t.skip('no Python 3 interpreter available');
  const run = await runHelper([], 'not json at all');
  assert.equal(run.code, 2);
  assert.match(run.stdout, /"error"/);
  assert.match(run.stderr, /scan_project\.py: invalid request JSON/);
});

test('an unknown mode section exits 2 instead of silently producing no sections', async (t) => {
  if (!(await helperAvailable())) return t.skip('no Python 3 interpreter available');
  const run = await runHelper([], JSON.stringify({ mode: 'bogus', root: '.' }));
  assert.equal(run.code, 2);
  assert.match(run.stdout, /unknown mode section/);
});

test('a non-directory root exits 2', async (t) => {
  if (!(await helperAvailable())) return t.skip('no Python 3 interpreter available');
  const run = await runHelper([], JSON.stringify({ root: '/definitely/not/a/directory-xyz' }));
  assert.equal(run.code, 2);
  assert.match(run.stdout, /not a directory/);
});

test('flags alone drive the scan without a stdin request', async (t) => {
  if (!(await helperAvailable())) return t.skip('no Python 3 interpreter available');
  const run = await runHelper(['--mode', 'manifest', '--root', process.cwd()]);
  assert.equal(run.code, 0);
  const payload = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(payload.mode, 'manifest');
  assert.equal(payload.scannerVersion, SUPPORTED_SCANNER_VERSION);
  assert.ok('manifest' in payload);
  assert.equal('imports' in payload, false, 'unrequested sections must not be produced');
  assert.equal('environment' in payload, false);
});

test('a comma-separated mode selects exactly those sections', async (t) => {
  if (!(await helperAvailable())) return t.skip('no Python 3 interpreter available');
  const run = await runHelper(
    [],
    JSON.stringify({ mode: 'environment,manifest', root: process.cwd() }),
  );
  assert.equal(run.code, 0);
  const payload = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(payload.mode, 'environment,manifest');
  assert.ok('environment' in payload);
  assert.ok('manifest' in payload);
  assert.equal('imports' in payload, false);
});

test('the mode section order is canonical regardless of request order', async (t) => {
  if (!(await helperAvailable())) return t.skip('no Python 3 interpreter available');
  const run = await runHelper([], JSON.stringify({ mode: 'imports,environment', root: '.' }));
  assert.equal(run.code, 0);
  const payload = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(payload.mode, 'environment,imports');
});

test('a src directory holding no Python is not reported as a module', async (t) => {
  if (!(await helperAvailable())) return t.skip('no Python 3 interpreter available');
  // This repository is a TypeScript project with a src/ tree, so a naive
  // implementation reports core, project, build, ... as Python modules.
  const run = await runHelper([], JSON.stringify({ mode: 'manifest', root: process.cwd() }));
  assert.equal(run.code, 0);
  const payload = JSON.parse(run.stdout) as { manifest: { modules: string[] } };
  assert.deepEqual(payload.manifest.modules, []);
});

test('a broken or missing packaging degrades to name-only comparison', async (t) => {
  if (!(await helperAvailable())) return t.skip('no Python 3 interpreter available');
  const root = await mkdtemp(join(tmpdir(), 'py-nopkg-'));
  const shim = await mkdtemp(join(tmpdir(), 'py-shim-'));
  try {
    await writeFile(
      join(root, 'pyproject.toml'),
      '[project]\nname = "ledger"\nversion = "0.1.0"\nrequires-python = ">=3.11"\ndependencies = ["requests>=2.31", "missing-dep>=1"]\n',
    );
    await writeFile(
      join(root, 'uv.lock'),
      'version = 1\nrevision = 2\nrequires-python = ">=3.11"\n\n[[package]]\nname = "requests"\nversion = "2.30.0"\nsource = { registry = "https://pypi.org/simple" }\n',
    );
    // Shadow the real module so the optional import fails deterministically.
    await writeFile(join(shim, 'packaging.py'), 'raise ImportError("blocked for testing")\n');

    const run = await runHelper([], JSON.stringify({ mode: 'manifest', root }), {
      PYTHONPATH: shim,
    });
    assert.equal(run.code, 0, `scanner must still succeed: ${run.stderr}`);
    const payload = JSON.parse(run.stdout) as {
      manifest: { name: string };
      lockComparison: {
        specifierCheckAvailable: boolean;
        unsatisfiedInLock: unknown[];
        missingFromLock: string[];
      };
    };
    assert.equal(payload.manifest.name, 'ledger');
    assert.equal(payload.lockComparison.specifierCheckAvailable, false);
    assert.deepEqual(payload.lockComparison.unsatisfiedInLock, []);
    // The name-only comparison that does not need packaging still runs.
    assert.deepEqual(payload.lockComparison.missingFromLock, ['missing-dep']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(shim, { recursive: true, force: true });
  }
});
