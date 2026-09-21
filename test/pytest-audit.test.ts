import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditPytestConfiguration,
  parseIniPytestOptions,
  resolvePytestOptions,
  type PytestAuditInput,
} from '../src/build/pytest-audit.ts';

function input(overrides: Partial<PytestAuditInput> = {}): PytestAuditInput {
  return {
    sources: ['pyproject.toml'],
    options: { testpaths: [], markers: [] },
    declared: new Set<string>(),
    unmarkedAsyncTests: [],
    missingTestPaths: [],
    hasTestFiles: true,
    ...overrides,
  };
}

const codes = (findings: { code: string }[]): string[] => findings.map((entry) => entry.code);

test('an INI file without a pytest section does not configure pytest', () => {
  assert.equal(parseIniPytestOptions(undefined), undefined);
  assert.equal(parseIniPytestOptions('[metadata]\nname = x\n'), undefined);
  // `[tool:pytest]` is the setup.cfg/tox.ini spelling and does configure pytest.
  assert.deepEqual(parseIniPytestOptions('[tool:pytest]\n'), { testpaths: [], markers: [] });
});

test('INI pytest options are read from either section spelling', () => {
  const ini =
    '[pytest]\nasyncio_mode = auto\naddopts = -q --cov=pkg\ntestpaths = tests src/tests\n';
  const parsed = parseIniPytestOptions(ini);
  assert.equal(parsed?.asyncioMode, 'auto');
  assert.equal(parsed?.addopts, '-q --cov=pkg');
  assert.deepEqual(parsed?.testpaths, ['tests', 'src/tests']);

  const setupCfg = '[tool:pytest]\ntestpaths = tests\n';
  assert.deepEqual(parseIniPytestOptions(setupCfg)?.testpaths, ['tests']);

  // A section with no recognised option still counts as configured.
  assert.deepEqual(parseIniPytestOptions('[pytest]\n'), {
    testpaths: [],
    markers: [],
  });
});

test('pytest uses the first configuration file it finds', () => {
  const merged = resolvePytestOptions({
    pyprojectOptions: { testpaths: ['tests'] },
    iniFiles: { 'pytest.ini': '[pytest]\nasyncio_mode = auto\n', 'tox.ini': '[pytest]\n' },
  });
  assert.deepEqual(merged.sources, ['pytest.ini']);
  assert.equal(merged.options.asyncioMode, 'auto');

  const pyprojectWins = resolvePytestOptions({
    pyprojectOptions: { testpaths: ['tests'] },
    iniFiles: { 'tox.ini': '[pytest]\ntestpaths = other\n' },
  });
  assert.deepEqual(pyprojectWins.sources, ['pyproject.toml']);
  assert.deepEqual(pyprojectWins.options.testpaths, ['tests']);

  const none = resolvePytestOptions({ iniFiles: {} });
  assert.deepEqual(none.sources, []);
  assert.deepEqual(none.options, { testpaths: [], markers: [] });
});

test('async tests without any async plugin are reported as never running', () => {
  const findings = auditPytestConfiguration(
    input({ unmarkedAsyncTests: [{ path: 'tests/test_api.py', tests: ['test_fetch'] }] }),
  );
  assert.deepEqual(codes(findings), ['ASYNC_TESTS_WITHOUT_PLUGIN']);
  assert.equal(findings[0].severity, 'error');
});

test('unmarked async tests with pytest-asyncio are reported as skipped', () => {
  const findings = auditPytestConfiguration(
    input({
      declared: new Set(['pytest-asyncio']),
      unmarkedAsyncTests: [{ path: 'tests/test_api.py', tests: ['test_fetch', 'test_send'] }],
    }),
  );
  assert.deepEqual(codes(findings), ['ASYNC_TESTS_REQUIRE_MARKER']);
  assert.match(findings[0].message, /2 async test function/);
});

test('asyncio_mode auto makes unmarked async tests run', () => {
  const findings = auditPytestConfiguration(
    input({
      declared: new Set(['pytest-asyncio']),
      options: { asyncioMode: 'auto', testpaths: [], markers: [] },
      unmarkedAsyncTests: [{ path: 'tests/test_api.py', tests: ['test_fetch'] }],
    }),
  );
  assert.deepEqual(findings, []);
});

test('asyncio_mode without the plugin is an error, not a silent default', () => {
  const findings = auditPytestConfiguration(
    input({ options: { asyncioMode: 'auto', testpaths: [], markers: [] } }),
  );
  assert.deepEqual(codes(findings), ['ASYNCIO_MODE_WITHOUT_PLUGIN']);
});

test('--cov without pytest-cov is reported before the run fails', () => {
  const findings = auditPytestConfiguration(
    input({ options: { addopts: '-q --cov=pkg', testpaths: [], markers: [] } }),
  );
  assert.deepEqual(codes(findings), ['COVERAGE_OPTION_WITHOUT_PLUGIN']);

  const declared = auditPytestConfiguration(
    input({
      declared: new Set(['pytest-cov']),
      options: { addopts: '-q --cov=pkg', testpaths: [], markers: [] },
    }),
  );
  assert.deepEqual(declared, []);

  // `--cov-report` is a different option and must not be mistaken for `--cov`.
  const reportOnly = auditPytestConfiguration(
    input({ options: { addopts: '--cov-report=term', testpaths: [], markers: [] } }),
  );
  assert.deepEqual(reportOnly, []);
});

test('a testpath that does not exist is a warning, not an error', () => {
  const findings = auditPytestConfiguration(
    input({ options: { testpaths: ['tests'], markers: [] }, missingTestPaths: ['tests'] }),
  );
  assert.deepEqual(codes(findings), ['TESTPATH_MISSING']);
  assert.equal(findings[0].severity, 'warning');
});

test('missing configuration is information, not a failure', () => {
  const findings = auditPytestConfiguration(input({ sources: [] }));
  assert.deepEqual(codes(findings), ['PYTEST_NOT_CONFIGURED']);
  assert.equal(findings[0].severity, 'info');

  // No test files at all: nothing to configure, nothing to report.
  assert.deepEqual(auditPytestConfiguration(input({ sources: [], hasTestFiles: false })), []);
});
