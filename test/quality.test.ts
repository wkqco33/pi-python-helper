import test from 'node:test';
import assert from 'node:assert/strict';
import { qualityCommands, selectQualityRunners } from '../src/build/quality.ts';
import { summarizeValidation } from '../src/validation/bundle.ts';

test('a declared linter becomes part of the gate even without a config table', () => {
  // `ruff check .` works with no [tool.ruff] table, and CI usually installs it
  // from the dev extra, so gating on the declaration is what matches CI.
  const runners = selectQualityRunners({ declared: ['ruff', 'pytest'] });
  assert.deepEqual(
    runners.map((runner) => runner.name),
    ['ruff'],
  );
});

test('an undeclared tool is never run', () => {
  assert.deepEqual(selectQualityRunners({ declared: ['pytest', 'coverage'] }), []);
  assert.deepEqual(selectQualityRunners({ declared: [] }), []);
});

test('mypy only runs when the project configures it', () => {
  assert.deepEqual(selectQualityRunners({ declared: ['mypy'] }), []);
  assert.deepEqual(
    selectQualityRunners({ declared: ['mypy'], toolConfiguration: { mypy: false } }),
    [],
  );
  assert.deepEqual(
    selectQualityRunners({ declared: ['mypy'], toolConfiguration: { mypy: true } }).map(
      (runner) => runner.name,
    ),
    ['mypy'],
  );
});

test('every quality command runs through uv run so it comes from the project environment', () => {
  const runners = selectQualityRunners({ declared: ['ruff', 'pyright'] });
  assert.deepEqual(
    qualityCommands('/tmp/project', runners).map((command) => ({
      executable: command.executable,
      args: command.args,
      risk: command.risk,
    })),
    [
      { executable: 'uv', args: ['run', '--frozen', 'ruff', 'check', '.'], risk: 'read' },
      { executable: 'uv', args: ['run', '--frozen', 'pyright'], risk: 'read' },
    ],
  );
});

test('a project that declares no quality tool is not penalised', () => {
  const summary = summarizeValidation({
    lock: { executed: true, ok: true },
    sync: { executed: true, ok: true },
    test: { executed: true, ok: true, failures: 0 },
    quality: [],
    conformance: 'consistent',
    stale: false,
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.checks.quality, true);
});

test('a failing quality step fails the gate and names the tool', () => {
  const summary = summarizeValidation({
    lock: { executed: true, ok: true },
    sync: { executed: true, ok: true },
    test: { executed: true, ok: true, failures: 0 },
    quality: [
      { name: 'ruff', executed: true, ok: true, exitCode: 0 },
      { name: 'pyright', executed: true, ok: false, exitCode: 1 },
    ],
    conformance: 'consistent',
    stale: false,
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.checks.quality, false);
  assert.match(summary.reason, /quality check\(s\) failed: pyright/);
});

test('a skipped test step reports the reason instead of a generic failure', () => {
  // This is the shape a sync that removed pytest produces: the sync exited 0,
  // so the run looks successful until the missing tool is named.
  const summary = summarizeValidation({
    lock: { executed: true, ok: true },
    sync: { executed: true, ok: false },
    test: {
      name: 'pytest',
      executed: false,
      ok: false,
      exitCode: null,
      skippedReason: 'pytest is not installed in the project environment after uv sync.',
    },
    quality: [],
    conformance: 'consistent',
    stale: false,
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.checks.test, false);
  assert.match(summary.reason, /could not be completed/);
});

test('a test step skipped after a successful sync reports the skip reason', () => {
  const summary = summarizeValidation({
    lock: { executed: true, ok: true },
    sync: { executed: true, ok: true },
    test: {
      name: 'pytest',
      executed: false,
      ok: false,
      skippedReason: 'pytest is not installed in the project environment after uv sync.',
    },
    quality: [],
    conformance: 'consistent',
    stale: false,
  });
  assert.equal(summary.ok, false);
  assert.match(summary.reason, /pytest is not installed/);
});

test('quality checks are reported as skipped when the tests did not pass', () => {
  const summary = summarizeValidation({
    lock: { executed: true, ok: true },
    sync: { executed: true, ok: true },
    test: { executed: true, ok: false, failures: 2 },
    quality: [
      {
        name: 'ruff',
        executed: false,
        ok: false,
        skippedReason: 'Tests did not pass, so the quality check was skipped.',
      },
    ],
    conformance: 'consistent',
    stale: false,
  });
  assert.equal(summary.ok, false);
  // The failing test is the first actionable signal, so it owns the reason.
  assert.match(summary.reason, /Tests failed/);
  assert.equal(summary.checks.quality, false);
});
