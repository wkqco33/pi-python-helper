import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTests } from '../src/build/selection.ts';
import { checkTdd } from '../src/validation/tdd.ts';
import { summarizeValidation } from '../src/validation/bundle.ts';
import { buildCompletionEvidence } from '../src/validation/evidence.ts';

const TEST_FILES = [
  'tests/conftest.py',
  'tests/test_parser.py',
  'tests/test_unrelated.py',
  'src/demo_pkg/test_inline.py',
];

test('a test file named after the changed module outranks a directory-only match', () => {
  const result = selectTests(['src/demo_pkg/parser.py'], TEST_FILES);
  assert.equal(result.fellBackToAll, false);
  assert.equal(result.selected[0].path, 'tests/test_parser.py');
  assert.match(result.selected[0].reason, /module name matches/);
  const parser = result.selected.find((entry) => entry.path === 'tests/test_parser.py');
  const unrelated = result.selected.find((entry) => entry.path === 'tests/test_unrelated.py');
  assert.ok(parser && parser.score > 0);
  assert.equal(unrelated, undefined);
});

test('a shared conftest is always in scope once tests are selected', () => {
  const result = selectTests(['src/demo_pkg/parser.py'], TEST_FILES);
  assert.ok(result.selected.some((entry) => entry.path === 'tests/conftest.py'));
});

test('changing a test file selects that test file', () => {
  const result = selectTests(['tests/test_unrelated.py'], TEST_FILES);
  assert.equal(result.selected[0].path, 'tests/test_unrelated.py');
  assert.match(result.selected[0].reason, /test file itself changed/);
  assert.deepEqual(result.changedTestFiles, ['tests/test_unrelated.py']);
});

test('an unmatchable change falls back to the whole suite instead of reporting nothing', () => {
  const result = selectTests(['src/demo_pkg/brandnew_thing.py'], ['tests/test_unrelated.py']);
  assert.equal(result.fellBackToAll, true);
  assert.equal(result.selected.length, 1);
  assert.match(result.selected[0].reason, /full suite/);
});

test('a non-Python change selects nothing without claiming a fallback', () => {
  const result = selectTests(['docs/guide.md', 'pyproject.toml'], TEST_FILES);
  assert.deepEqual(result.selected, []);
  assert.equal(result.fellBackToAll, false);
  assert.deepEqual(result.changedSourceFiles, []);
});

test('TDD checkpoint requires a related test for production changes', () => {
  const related = checkTdd(['src/app/parser.py'], ['tests/test_parser.py']);
  assert.equal(related.ok, true);
  assert.deepEqual(related.sourceChanges, ['src/app/parser.py']);

  const missing = checkTdd(['src/app/parser.py'], []);
  assert.equal(missing.ok, false);
  assert.match(missing.reasons[0], /without any test file change/);

  const unrelated = checkTdd(['src/app/parser.py', 'tests/test_other.py']);
  assert.equal(unrelated.ok, false);
  assert.match(unrelated.reasons[0], /do not appear related/);

  const docsOnly = checkTdd(['README.md', 'pyproject.toml'], []);
  assert.equal(docsOnly.ok, true);
});

test('TDD checkpoint does not treat a test file as production code', () => {
  const checkpoint = checkTdd(['tests/test_parser.py'], ['tests/test_parser.py']);
  assert.deepEqual(checkpoint.sourceChanges, []);
  assert.equal(checkpoint.ok, true);
});

test('validation summary fails when any step was never executed', () => {
  const preview = summarizeValidation({
    lock: { executed: false, ok: false },
    sync: { executed: false, ok: false },
    test: { executed: false, ok: false },
    conformance: 'unverifiable',
    stale: false,
  });
  assert.equal(preview.ok, false);
  assert.match(preview.reason, /execute=true/);

  const staleData = summarizeValidation({
    lock: { executed: true, ok: true },
    sync: { executed: true, ok: true },
    test: { executed: true, ok: true, failures: 0 },
    conformance: 'consistent',
    stale: true,
  });
  assert.equal(staleData.ok, false);
  assert.equal(staleData.checks.staleArtifacts, true);

  const pass = summarizeValidation({
    lock: { executed: true, ok: true },
    sync: { executed: true, ok: true },
    test: { executed: true, ok: true, failures: 0 },
    conformance: 'consistent',
    stale: false,
  });
  assert.equal(pass.ok, true);
});

test('a passing test run is not proof when the environment does not match the lock', () => {
  const drifted = summarizeValidation({
    lock: { executed: true, ok: true },
    sync: { executed: true, ok: true },
    test: { executed: true, ok: true, failures: 0 },
    conformance: 'drifted',
    stale: false,
  });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.checks.conformance, false);
  assert.match(drifted.reason, /do not match uv\.lock/);

  const unverifiable = summarizeValidation({
    lock: { executed: true, ok: true },
    sync: { executed: true, ok: true },
    test: { executed: true, ok: true, failures: 0 },
    conformance: 'unverifiable',
    stale: false,
  });
  assert.equal(unverifiable.ok, false);
  assert.match(unverifiable.reason, /not proven/);
});

test('completion evidence blocks on a partial run', () => {
  const partial = buildCompletionEvidence({
    syncExecuted: true,
    syncOk: true,
    testExecuted: false,
    testOk: false,
    stale: false,
    changedPaths: ['src/app/parser.py'],
  });
  assert.equal(partial.ok, false);
  assert.equal(partial.blockers.length, 1);
  assert.match(partial.blockers[0], /Tests were not executed/);

  const complete = buildCompletionEvidence({
    syncExecuted: true,
    syncOk: true,
    testExecuted: true,
    testOk: true,
    stale: false,
    changedPaths: [],
  });
  assert.equal(complete.ok, true);
});
