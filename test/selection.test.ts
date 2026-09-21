import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTests, modulePathsFromFile } from '../src/build/selection.ts';
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
    preview: true,
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

/**
 * The layout that produced "30 of 30 selected": every test lives inside the
 * package under test, so the package name matched every candidate.
 */
const PACKAGE_ROOTED_TESTS = [
  'pkg/tests/__init__.py',
  'pkg/tests/conftest.py',
  'pkg/tests/test_api.py',
  'pkg/tests/test_admin.py',
  'pkg/tests/unit/test_db_session.py',
];

test('a package-rooted test tree is narrowed instead of matching everything', () => {
  const result = selectTests(['pkg/routes/admin.py'], PACKAGE_ROOTED_TESTS);
  assert.equal(result.fellBackToAll, false);
  assert.equal(result.narrowed, true);
  assert.deepEqual(
    result.selected.filter((entry) => entry.path.startsWith('pkg/tests/test')).map((e) => e.path),
    ['pkg/tests/test_admin.py'],
  );
  // A test named after an unrelated module must not be dragged in.
  assert.equal(
    result.selected.some((entry) => entry.path === 'pkg/tests/test_api.py'),
    false,
  );
});

test('test infrastructure is reported separately and never selected as a target', () => {
  const result = selectTests(['pkg/routes/admin.py'], PACKAGE_ROOTED_TESTS);
  assert.deepEqual(result.supportFiles, ['pkg/tests/__init__.py', 'pkg/tests/conftest.py']);
  assert.equal(
    result.selected.some((entry) => entry.path === 'pkg/tests/__init__.py'),
    false,
  );
  // A conftest still shapes the run, so it stays visible.
  assert.equal(
    result.selected.some((entry) => entry.path === 'pkg/tests/conftest.py'),
    true,
  );
});

test('importing the changed module is the strongest naming-free signal', () => {
  const result = selectTests(
    ['pkg/db/database.py'],
    ['pkg/tests/unit/test_db_session.py', 'pkg/tests/test_unrelated.py'],
    {
      testImports: {
        'pkg/tests/unit/test_db_session.py': ['pkg.db.database'],
        'pkg/tests/test_unrelated.py': [],
      },
    },
  );
  assert.equal(result.importEvidenceUsed, true);
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].path, 'pkg/tests/unit/test_db_session.py');
  assert.match(result.selected[0].reason, /imports the changed module "pkg\.db\.database"/);
  assert.equal(result.narrowed, true);
});

test('without import evidence the selection falls back instead of guessing', () => {
  const result = selectTests(
    ['pkg/db/database.py'],
    ['pkg/tests/unit/test_db_session.py', 'pkg/tests/test_other.py'],
    {
      testImports: {
        'pkg/tests/unit/test_db_session.py': ['somewhere.else'],
        'pkg/tests/test_other.py': ['somewhere.else'],
      },
    },
  );
  assert.equal(result.importEvidenceUsed, false);
  assert.equal(result.fellBackToAll, true);
  assert.equal(result.narrowed, false);
});

test('a selection covering every candidate reports that it was not narrowed', () => {
  const result = selectTests(['pkg/a.py', 'pkg/b.py'], ['tests/test_a.py', 'tests/test_b.py']);
  assert.equal(result.fellBackToAll, false);
  assert.equal(result.narrowed, false);
  assert.equal(result.selected.length, 2);
});

test('a source path maps to the module names it can be imported as', () => {
  assert.deepEqual(modulePathsFromFile('src/demo/pkg/parser.py'), [
    'demo.pkg.parser',
    'src.demo.pkg.parser',
    'pkg.parser',
  ]);
  assert.deepEqual(modulePathsFromFile('pkg/__init__.py'), ['pkg']);
  assert.deepEqual(modulePathsFromFile('notes.md'), []);
});

test('the TDD checkpoint discloses a match that rests only on the package prefix', () => {
  const checkpoint = checkTdd(
    ['fastapi_server/db/database.py'],
    ['fastapi_server/tests/unit/test_db_session.py'],
  );
  assert.equal(checkpoint.ok, true);
  assert.equal(checkpoint.associations.length, 1);
  assert.deepEqual(checkpoint.associations[0].sharedTokens, ['fastapi', 'server']);
  // `database` and `db_session` share no module token, so the honest verdict is
  // that the names alone do not prove the relationship.
  assert.equal(checkpoint.associations[0].strength, 'package');
  assert.equal(checkpoint.weakAssociation, true);
});

test('a module-level token match is strong evidence', () => {
  const checkpoint = checkTdd(['src/demo/parser.py'], ['tests/test_parser.py']);
  assert.equal(checkpoint.weakAssociation, false);
  assert.equal(checkpoint.associations[0].strength, 'module');
  assert.deepEqual(checkpoint.associations[0].sharedTokens, ['parser']);
});
