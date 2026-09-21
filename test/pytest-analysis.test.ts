import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePytestOutput, totalTests } from '../src/build/pytest.ts';
import {
  diagnoseFailure,
  extractTracebackFrames,
  isLibraryFrame,
  refineWithDeclarations,
} from '../src/build/failure.ts';

const PASSING = `============================= test session starts ==============================
collected 3 items

tests/test_api.py ...                                                    [100%]

============================== 3 passed in 0.12s ===============================
`;

const FAILING = `============================= test session starts ==============================
collected 4 items

tests/test_api.py ..F.                                                   [ 75%]

=================================== FAILURES ===================================
_________________________________ test_total __________________________________

    def test_total():
        result = add_items([1, 2])
>       assert result == 4
E       assert 3 == 4
E        +  where 3 = add_items([1, 2])

src/api/totals.py:12: AssertionError
=========================== short test summary info ============================
FAILED tests/test_api.py::test_total - assert 3 == 4
ERROR tests/test_api.py::test_other - fixture 'client' not found
========================= 1 failed, 2 passed, 1 error in 0.31s =========================
`;

test('pytest summary counts are parsed from the final summary line', () => {
  const passing = parsePytestOutput(PASSING);
  assert.equal(passing.counts.passed, 3);
  assert.equal(passing.counts.failed, 0);
  assert.equal(totalTests(passing.counts), 3);
  assert.equal(passing.incomplete, false);
  assert.deepEqual(passing.failures, []);
});

test('pytest short summary yields node ids, files, and messages', () => {
  const report = parsePytestOutput(FAILING);
  assert.equal(report.counts.failed, 1);
  assert.equal(report.counts.errors, 1);
  assert.equal(report.counts.passed, 2);
  assert.equal(report.failures.length, 2);
  assert.equal(report.failures[0].test, 'tests/test_api.py::test_total');
  assert.equal(report.failures[0].file, 'tests/test_api.py');
  assert.equal(report.failures[0].message, 'assert 3 == 4');
  assert.equal(report.failures[0].kind, 'FAILED');
  assert.equal(report.failures[1].kind, 'ERROR');
});

test('a run without a summary is reported as incomplete rather than passing', () => {
  const report = parsePytestOutput('Traceback (most recent call last):\nRuntimeError: boom\n');
  assert.equal(report.incomplete, true);
  assert.equal(report.counts.passed, 0);
});

test('no tests ran is distinguished from an incomplete run', () => {
  const report = parsePytestOutput('===== no tests ran in 0.01s =====\n');
  assert.equal(report.noTestsRan, true);
  assert.equal(report.incomplete, false);
});

test('library frames are separated from project frames', () => {
  assert.equal(isLibraryFrame('/usr/lib/python3.12/site-packages/requests/api.py'), true);
  assert.equal(isLibraryFrame('/home/u/proj/.venv/lib/python3.12/site-packages/x/y.py'), true);
  assert.equal(isLibraryFrame('/usr/lib/python3.12/argparse.py'), true);
  assert.equal(isLibraryFrame('src/api/totals.py'), false);
});

test('the first user frame is the last non-library frame in the traceback', () => {
  const output = `Traceback (most recent call last):
  File "/home/u/proj/.venv/lib/python3.12/site-packages/pluggy/_callers.py", line 167, in _multicall
    raise exception
  File "/home/u/proj/src/api/handlers.py", line 42, in handle
    return parse(payload)
  File "/home/u/proj/src/api/parse.py", line 17, in parse
    return int(payload["n"])
ValueError: invalid literal for int() with base 10: 'x'
`;
  const frames = extractTracebackFrames(output);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].library, true);
  assert.equal(frames[1].library, false);

  const diagnosis = diagnoseFailure(output);
  assert.equal(diagnosis.kind, 'runtime_error');
  assert.equal(diagnosis.exceptionType, 'ValueError');
  assert.equal(diagnosis.firstUserFrame?.path, '/home/u/proj/src/api/parse.py');
  assert.equal(diagnosis.firstUserFrame?.line, 17);
});

test('pytest short tracebacks yield a frame and a classified exception', () => {
  const output = `=================================== FAILURES ===================================
_________________________________ test_fails __________________________________

tests/test_broken.py:2: in test_fails
    assert total([1]) == 2
E   NameError: name 'total' is not defined
=========================== short test summary info ============================
FAILED tests/test_broken.py::test_fails - NameError: name 'total' is not defined
========================= 1 failed, 1 passed in 0.21s =========================
`;
  const diagnosis = diagnoseFailure(output);
  assert.equal(diagnosis.kind, 'runtime_error');
  assert.equal(diagnosis.exceptionType, 'NameError');
  assert.equal(diagnosis.firstUserFrame?.path, 'tests/test_broken.py');
  assert.equal(diagnosis.firstUserFrame?.line, 2);
  assert.match(diagnosis.suggestions[0].message, /tests\/test_broken\.py:2/);
});

test('uv lockfile staleness is diagnosed before anything downstream', () => {
  const diagnosis = diagnoseFailure(
    'error: The lockfile at `uv.lock` needs to be updated, but `--locked` was provided.\n',
  );
  assert.equal(diagnosis.kind, 'lockfile_out_of_date');
  assert.equal(diagnosis.suggestions[0].command, 'uv lock');
});

test('dependency conflicts and resolution errors are distinct kinds', () => {
  const conflict = diagnoseFailure(
    'error: No solution found when resolving dependencies:\n  Because a depends on b>=2 and c depends on b<2, we can conclude that the requirements are unsatisfiable.\n',
  );
  assert.equal(conflict.kind, 'dependency_conflict');

  const unresolved = diagnoseFailure(
    'error: Failed to resolve requirements from requirements.txt\n',
  );
  assert.equal(unresolved.kind, 'resolution_error');
});

test('missing modules, syntax errors, fixtures, and assertions are classified', () => {
  assert.equal(
    diagnoseFailure("ModuleNotFoundError: No module named 'pandas'\n").kind,
    'module_not_found',
  );
  assert.equal(
    diagnoseFailure("ImportError: cannot import name 'parse' from 'app.utils'\n").kind,
    'import_error',
  );
  assert.equal(diagnoseFailure('SyntaxError: invalid syntax\n').kind, 'syntax_error');
  assert.equal(diagnoseFailure("E       fixture 'client' not found\n").kind, 'fixture_error');
});

test('an assertion failure inside a pytest report outranks a later fixture error', () => {
  const diagnosis = diagnoseFailure(FAILING);
  assert.equal(diagnosis.kind, 'assertion');
  assert.match(diagnosis.evidence[0].message, /assert 3 == 4/);
});

test('a declared but unimportable module is an environment problem, not a declaration problem', () => {
  const base = diagnoseFailure("ModuleNotFoundError: No module named 'pandas'\n");
  assert.equal(base.suggestions[0].command, 'uv add pandas');

  const declared = refineWithDeclarations(base, {
    declared: new Set(['pandas']),
    localModules: new Set(),
  });
  assert.equal(declared.kind, 'environment_not_synced');
  assert.equal(declared.suggestions[0].command, 'uv sync --frozen');
  assert.match(declared.summary, /declared in pyproject\.toml/);

  const local = refineWithDeclarations(base, {
    declared: new Set(),
    localModules: new Set(['pandas']),
  });
  assert.equal(local.kind, 'environment_not_synced');
  assert.match(local.summary, /project code/);
});

/**
 * `uv add <import name>` installs a different package or nothing at all when
 * the import name and the distribution name disagree (`wconfig`/`wpyconf`,
 * `yaml`/`PyYAML`). Only a single unambiguous alias may become a command.
 */
test('a module with a known distribution is suggested by distribution, not import name', () => {
  const yaml = diagnoseFailure("ModuleNotFoundError: No module named 'yaml'\n");
  assert.equal(yaml.suggestions[0].command, 'uv add pyyaml');
  assert.equal(
    yaml.suggestions.some((entry) => entry.command === 'uv add yaml'),
    false,
  );
});

test('an import with no known distribution never gets a fabricated uv add command', () => {
  const unknown = diagnoseFailure("ModuleNotFoundError: No module named 'wconfig'\n");
  assert.equal(unknown.kind, 'module_not_found');
  assert.equal(
    unknown.suggestions.some((entry) => entry.command?.startsWith('uv add')),
    false,
  );
  assert.match(
    unknown.suggestions.map((entry) => entry.message).join(' '),
    /verify the distribution/i,
  );
});

test('an import with several candidate distributions is not resolved to one command', () => {
  const cv2 = diagnoseFailure("ModuleNotFoundError: No module named 'cv2'\n");
  assert.equal(
    cv2.suggestions.some((entry) => entry.command?.startsWith('uv add')),
    false,
  );
  const messages = cv2.suggestions.map((entry) => entry.message).join(' ');
  assert.match(messages, /opencv-python/);
  assert.match(messages, /opencv-python-headless/);
});

test('refining an unresolved module repeats no suggestion', () => {
  const base = diagnoseFailure("ModuleNotFoundError: No module named 'wconfig'\n");
  const refined = refineWithDeclarations(base, {
    declared: new Set(),
    localModules: new Set(),
  });
  const messages = refined.suggestions.map((entry) => entry.message);
  assert.equal(messages.length, new Set(messages).size);
  assert.equal(refined.suggestions.length, base.suggestions.length);
});

/**
 * The exact shape `uv run --frozen pytest` produced after a sync removed the
 * project's dev tooling. It is not a code failure, and classifying it as
 * "unknown" left the caller to guess.
 */
const SPAWN_FAILURE = `error: Failed to spawn: \`pytest\`
  cause: No such file or directory (os error 2)`;

const SHELL_MISSING_TOOL = `sh: ruff: command not found`;

test('a tool that cannot be spawned is classified as an environment failure', () => {
  const diagnosis = diagnoseFailure(SPAWN_FAILURE);
  assert.equal(diagnosis.kind, 'tool_not_installed');
  assert.equal(diagnosis.missingTool, 'pytest');
  assert.match(diagnosis.summary, /not installed/);
  assert.equal(diagnosis.suggestions[0].command, 'uv sync --frozen --all-groups --all-extras');
  assert.match(
    diagnosis.suggestions.map((entry) => entry.message).join(' '),
    /optional-dependencies/,
  );
});

test('a shell that cannot find a tool is classified the same way', () => {
  const diagnosis = diagnoseFailure(SHELL_MISSING_TOOL);
  assert.equal(diagnosis.kind, 'tool_not_installed');
  assert.equal(diagnosis.missingTool, 'ruff');
});

test('a missing tool is never reported as an unclassified failure', () => {
  const diagnosis = diagnoseFailure(SPAWN_FAILURE);
  assert.notEqual(diagnosis.kind, 'unknown');
  assert.equal(diagnosis.frames.length, 0);
  assert.equal(diagnosis.firstUserFrame, undefined);
});

test('a traceback that precedes a spawn error keeps its own classification', () => {
  // The contract is "first actionable cause", so position decides: a real code
  // failure printed before the environment failure must win.
  const diagnosis = diagnoseFailure(
    [
      'E   AssertionError: 1 != 2',
      '',
      'error: Failed to spawn: `pytest`',
      '  cause: No such file or directory (os error 2)',
    ].join('\n'),
  );
  assert.equal(diagnosis.kind, 'assertion');
});

test('an already-classified module failure is not overridden by a spawn error', () => {
  const diagnosis = diagnoseFailure(
    [
      "ModuleNotFoundError: No module named 'wconfig'",
      '',
      'error: Failed to spawn: `pytest`',
      '  cause: No such file or directory (os error 2)',
    ].join('\n'),
  );
  assert.equal(diagnosis.kind, 'module_not_found');
  assert.equal(diagnosis.missingModule, 'wconfig');
});
