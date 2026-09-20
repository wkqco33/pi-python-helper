/**
 * Manual end-to-end verification against a real uv project.
 *
 * Not part of `npm test`: it needs network access (uv resolves pytest) and a
 * working uv installation. Run it with `npm run test:e2e` after changing the
 * scanner, the pytest parser, the failure diagnoser, or any uv command builder.
 *
 * The fixture is deliberately broken in three ways so each analysis path is
 * exercised: an undeclared runtime import, an undeclared TYPE_CHECKING import,
 * and a failing test.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import register from '../../extensions/index.ts';
import { runCommand } from '../../src/core/runner.ts';
import { resolveInterpreter } from '../../src/project/scanner.ts';

interface ToolResult {
  ok: boolean;
  summary: string;
  data?: Record<string, unknown>;
  warnings: { code?: string }[];
  errors: { code: string }[];
  suggestions: { command?: string }[];
}

const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ details: unknown }> }>();
register({
  registerTool: (tool: unknown) => {
    const typed = tool as { name: string };
    tools.set(typed.name, tool as never);
  },
  registerCommand: () => {},
} as never);

const PYPROJECT = `[project]
name = "ledger"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = []

[dependency-groups]
dev = ["pytest>=8"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.pytest.ini_options]
testpaths = ["tests"]
`;

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'py-helper-e2e-'));
  await mkdir(join(root, 'src', 'ledger'), { recursive: true });
  await mkdir(join(root, 'tests'), { recursive: true });
  await writeFile(join(root, 'pyproject.toml'), PYPROJECT);
  await writeFile(join(root, 'src', 'ledger', '__init__.py'), 'from ledger.totals import total\n');
  await writeFile(
    join(root, 'src', 'ledger', 'totals.py'),
    'def total(values: list[int]) -> int:\n    return sum(values)\n',
  );
  await writeFile(
    join(root, 'src', 'ledger', 'report.py'),
    'from typing import TYPE_CHECKING\nimport json\nimport numpy  # undeclared on purpose\n\nif TYPE_CHECKING:\n    import pandas  # undeclared, type-checking only\n',
  );
  await writeFile(
    join(root, 'tests', 'test_totals.py'),
    'from ledger.totals import total\n\n\ndef test_total():\n    assert total([1, 2]) == 3\n',
  );
  await writeFile(
    join(root, 'tests', 'test_broken.py'),
    'def test_fails():\n    assert total([1]) == 2\n',
  );
  return root;
}

async function main(): Promise<void> {
  if (!(await resolveInterpreter(process.cwd()))) {
    console.error('skipped: no Python 3 interpreter available');
    return;
  }
  const uvCheck = await runCommand('uv', ['--version'], {
    cwd: process.cwd(),
    timeoutMs: 10000,
    maxBytes: 4096,
  });
  if (uvCheck.code !== 0) {
    console.error('skipped: uv is not installed');
    return;
  }

  const root = await createFixture();
  const ctx = { cwd: root };
  const call = async (name: string, params: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    assert.ok(tool, `${name} must be registered`);
    const response = await tool.execute('e2e', params, undefined, undefined, ctx);
    return response.details as ToolResult;
  };

  try {
    const resolve = await runCommand('uv', ['lock'], {
      cwd: root,
      timeoutMs: 300000,
      maxBytes: 65536,
    });
    assert.equal(resolve.code, 0, `uv lock failed: ${resolve.stderr}`);

    const environment = await call('py_environment');
    assert.ok(environment.summary.includes('3.'), environment.summary);

    const inspection = await call('py_project_inspect');
    const inspectData = inspection.data as { name: string; layout: string };
    assert.equal(inspectData.name, 'ledger');
    assert.equal(inspectData.layout, 'src');
    assert.deepEqual(inspection.warnings, []);

    const dependencies = await call('py_dependency_plan');
    const planData = dependencies.data as {
      undeclared: { import: string; suggestedDistribution: string }[];
      drift: { missingFromLock: string[] };
    };
    assert.deepEqual(planData.undeclared.map((entry) => entry.import).sort(), ['numpy', 'pandas']);
    assert.deepEqual(planData.drift.missingFromLock, []);
    assert.ok(dependencies.suggestions.some((entry) => entry.command === 'uv add numpy'));
    assert.ok(dependencies.suggestions.some((entry) => entry.command === 'uv add --dev pandas'));

    const selection = await call('py_test_select', { changedPaths: ['src/ledger/totals.py'] });
    const selectionData = selection.data as { pytestTargets: string[] };
    assert.deepEqual(selectionData.pytestTargets, ['tests/test_totals.py']);

    const preview = await call('py_test', { targets: ['tests/test_totals.py'] });
    assert.equal((preview.data as { executed: boolean }).executed, false);

    const sync = await call('py_sync', { mode: 'sync', execute: true, timeoutSeconds: 300 });
    assert.equal(sync.ok, true, sync.summary);

    // The three legs of the environment question now agree: declared, locked, installed.
    const afterSync = await call('py_project_inspect');
    const afterSyncData = afterSync.data as {
      conformance: { verdict: string; complete: boolean; findings: unknown[] };
      installed: { count: number };
    };
    assert.equal(
      afterSyncData.conformance.verdict,
      'consistent',
      afterSyncData.conformance.verdict,
    );
    assert.equal(afterSyncData.conformance.complete, true);
    assert.deepEqual(afterSyncData.conformance.findings, []);
    assert.ok(afterSyncData.installed.count > 0, 'the environment must contain distributions');
    assert.deepEqual(afterSync.warnings, []);

    const run = await call('py_test', { execute: true, timeoutSeconds: 300 });
    const runData = run.data as {
      counts: { passed: number; failed: number };
      failures: { test: string }[];
      firstFailure?: { kind: string; firstUserFrame?: { path: string; line: number } };
    };
    assert.equal(runData.counts.passed, 1);
    assert.equal(runData.counts.failed, 1);
    assert.equal(runData.failures[0].test, 'tests/test_broken.py::test_fails');
    assert.equal(runData.firstFailure?.kind, 'runtime_error');
    assert.equal(runData.firstFailure?.firstUserFrame?.path, 'tests/test_broken.py');
    assert.equal(runData.firstFailure?.firstUserFrame?.line, 2);

    const evidence = await call('py_completion_evidence', {
      syncExecuted: true,
      syncOk: true,
      testExecuted: true,
      testOk: false,
      stale: false,
      changedPaths: ['src/ledger/totals.py'],
    });
    assert.equal(evidence.ok, false);
    assert.equal(evidence.errors[0].code, 'COMPLETION_NOT_PROVEN');

    // The bundle must not silently pass a test run against un-locked versions.
    const bundle = await call('py_validation_bundle', { execute: true, timeoutSeconds: 300 });
    const bundleData = bundle.data as {
      checks: { lock: boolean; sync: boolean; test: boolean; conformance: boolean };
    };
    assert.equal(bundle.ok, false, 'a failing test must fail the bundle');
    assert.equal(bundleData.checks.lock, true);
    assert.equal(bundleData.checks.sync, true);
    assert.equal(bundleData.checks.conformance, true);
    assert.equal(bundleData.checks.test, false);

    // Simulate `uv add` without `uv sync`: the lock moves on, the environment does not.
    const lockPath = join(root, 'uv.lock');
    const lockText = await readFile(lockPath, 'utf8');
    const edited = lockText.replace(
      /(\[\[package\]\]\nname = "pytest"\nversion = ")([^"]+)(")/,
      '$10.0.0$3',
    );
    assert.notEqual(edited, lockText, 'the fixture must contain a pytest entry in uv.lock');
    await writeFile(lockPath, edited);

    const drifted = await call('py_project_inspect');
    const driftedData = drifted.data as {
      conformance: {
        verdict: string;
        counts: { mismatched: number };
        findings: { code: string; name: string; expected?: string; actual?: string }[];
      };
    };
    assert.equal(driftedData.conformance.verdict, 'drifted');
    assert.equal(driftedData.conformance.counts.mismatched, 1);
    assert.equal(driftedData.conformance.findings[0].code, 'INSTALLED_VERSION_MISMATCH');
    assert.equal(driftedData.conformance.findings[0].name, 'pytest');
    assert.equal(driftedData.conformance.findings[0].expected, '0.0.0');
    assert.ok(driftedData.conformance.findings[0].actual?.startsWith('9'));
    assert.equal(drifted.ok, false);

    console.log('e2e verification passed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
