import { normalizeName } from '../dependencies/plan.ts';

/**
 * The pytest options this audit reasons about. Only options whose absence
 * changes whether tests *run* are read, so an unknown option can never be
 * misreported: pytest silently ignores a key it does not know, and so does this.
 */
export interface PytestOptions {
  asyncioMode?: string;
  addopts?: string;
  testpaths: string[];
  markers: string[];
}

export interface PytestConfigResolution {
  /** The configuration file pytest will actually use, when one exists. */
  sources: string[];
  options: PytestOptions;
}

/**
 * pytest uses the first configuration file it finds, in this order, and ignores
 * the rest. Merging them would invent options the run never sees.
 */
export const PYTEST_CONFIG_PRECEDENCE = [
  'pytest.ini',
  'pyproject.toml',
  'tox.ini',
  'setup.cfg',
] as const;

const INI_SECTION_RE = /^\s*\[(?:tool:)?pytest\]\s*$/m;

function emptyOptions(): PytestOptions {
  return { testpaths: [], markers: [] };
}

function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof value === 'string') {
    return value.split(/\s+/).filter((entry) => entry.length > 0);
  }
  return [];
}

/**
 * Read the `[pytest]` / `[tool:pytest]` section of one INI file.
 *
 * `undefined` means "this file does not configure pytest". A file that has the
 * section but none of the options still counts as configured, so the caller can
 * distinguish "no configuration" from "configuration with defaults".
 */
export function parseIniPytestOptions(content: string | undefined): PytestOptions | undefined {
  if (content === undefined) return undefined;
  const header = INI_SECTION_RE.exec(content);
  if (!header) return undefined;
  const rest = content.slice(header.index + header[0].length);
  const nextSection = rest.search(/^\s*\[/m);
  const body = nextSection === -1 ? rest : rest.slice(0, nextSection);
  const read = (key: string): string | undefined => {
    const found = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.*)$`, 'm').exec(body);
    const raw = found?.[1]?.trim();
    return raw ? raw : undefined;
  };

  const asyncioMode = read('asyncio_mode');
  const addopts = read('addopts');
  const testpaths = read('testpaths');
  return {
    ...(asyncioMode ? { asyncioMode } : {}),
    ...(addopts ? { addopts } : {}),
    testpaths: testpaths ? testpaths.split(/\s+/).filter((entry) => entry.length > 0) : [],
    markers: [],
  };
}

/**
 * Resolve the options pytest will use, honouring its first-file-wins rule.
 *
 * `pytest.ini` counts when it merely exists: unlike `tox.ini`/`setup.cfg` it has
 * no other purpose, so an empty file still sets the rootdir configuration.
 */
export function resolvePytestOptions(input: {
  pyprojectOptions?: Record<string, unknown> | null;
  iniFiles: Record<string, string | undefined>;
}): PytestConfigResolution {
  const raw = input.pyprojectOptions;
  const fromPyproject: PytestOptions | undefined = raw
    ? {
        ...(stringOption(raw['asyncio_mode'])
          ? { asyncioMode: stringOption(raw['asyncio_mode']) }
          : {}),
        ...(stringOption(raw['addopts']) ? { addopts: stringOption(raw['addopts']) } : {}),
        testpaths: stringList(raw['testpaths']),
        markers: stringList(raw['markers']),
      }
    : undefined;

  const pytestIni = input.iniFiles['pytest.ini'];
  const candidates: Record<string, PytestOptions | undefined> = {
    'pytest.ini':
      pytestIni === undefined ? undefined : (parseIniPytestOptions(pytestIni) ?? emptyOptions()),
    'pyproject.toml': fromPyproject,
    'tox.ini': parseIniPytestOptions(input.iniFiles['tox.ini']),
    'setup.cfg': parseIniPytestOptions(input.iniFiles['setup.cfg']),
  };

  for (const name of PYTEST_CONFIG_PRECEDENCE) {
    const options = candidates[name];
    if (options) return { sources: [name], options };
  }
  return { sources: [], options: emptyOptions() };
}

export interface AsyncTestFile {
  path: string;
  /** Async test names in this file that carry no async plugin marker. */
  tests: string[];
}

export interface PytestAuditInput {
  sources: string[];
  options: PytestOptions;
  declared: Set<string>;
  /** Async tests that no marker covers, per file. */
  unmarkedAsyncTests: AsyncTestFile[];
  /** Configured `testpaths` entries that do not exist on disk. */
  missingTestPaths: string[];
  hasTestFiles: boolean;
}

export interface PytestFinding {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  suggestion?: string;
}

/** Plugins that make pytest run a coroutine test function at all. */
const ASYNC_PLUGINS = ['pytest-asyncio', 'pytest-anyio', 'anyio', 'pytest-trio'];

function declares(declared: Set<string>, names: string[]): boolean {
  return names.some((name) => declared.has(normalizeName(name)));
}

/**
 * Report the pytest configuration problems that make tests pass without running.
 *
 * Only two things are asserted: coroutine tests that no plugin and no marker
 * will execute, and options that point at a plugin the project does not declare.
 * Anything less certain is reported as `info` so a false alarm cannot erode the
 * tool's credibility.
 */
export function auditPytestConfiguration(input: PytestAuditInput): PytestFinding[] {
  const findings: PytestFinding[] = [];
  const { options, declared } = input;
  const unmarkedFiles = input.unmarkedAsyncTests.filter((entry) => entry.tests.length > 0);
  const unmarkedCount = unmarkedFiles.reduce((total, entry) => total + entry.tests.length, 0);
  const asyncPluginDeclared = declares(declared, ASYNC_PLUGINS);
  const mode = (options.asyncioMode ?? '').trim().toLowerCase();

  if (unmarkedCount > 0 && !asyncPluginDeclared) {
    findings.push({
      code: 'ASYNC_TESTS_WITHOUT_PLUGIN',
      severity: 'error',
      message: `${unmarkedCount} async test function(s) in ${unmarkedFiles.length} file(s) will not run: no pytest async plugin is declared.`,
      suggestion:
        'Declare pytest-asyncio with uv add --dev pytest-asyncio and mark the tests, or add pytest-asyncio and set asyncio_mode = "auto".',
    });
  } else if (unmarkedCount > 0 && mode !== 'auto') {
    findings.push({
      code: 'ASYNC_TESTS_REQUIRE_MARKER',
      severity: 'error',
      message: `${unmarkedCount} async test function(s) in ${unmarkedFiles.length} file(s) carry no async marker and asyncio_mode is not "auto", so pytest-asyncio's strict default will skip them.`,
      suggestion:
        'Set asyncio_mode = "auto" in [tool.pytest.ini_options], or add @pytest.mark.asyncio to each async test.',
    });
  }

  if (mode.length > 0 && !declares(declared, ['pytest-asyncio'])) {
    findings.push({
      code: 'ASYNCIO_MODE_WITHOUT_PLUGIN',
      severity: 'error',
      message: `asyncio_mode is set to "${options.asyncioMode}" but pytest-asyncio is not declared, so pytest errors with an unknown option before collecting anything.`,
      suggestion:
        'Declare pytest-asyncio with uv add --dev pytest-asyncio, or remove asyncio_mode from the pytest configuration.',
    });
  }

  const addopts = options.addopts ?? '';
  if (/(^|\s)--cov(=|\s|$)/.test(addopts) && !declares(declared, ['pytest-cov'])) {
    findings.push({
      code: 'COVERAGE_OPTION_WITHOUT_PLUGIN',
      severity: 'error',
      message:
        'addopts passes --cov but pytest-cov is not declared, so every run fails with an unrecognized argument.',
      suggestion: 'Declare pytest-cov with uv add --dev pytest-cov, or remove --cov from addopts.',
    });
  }

  for (const path of input.missingTestPaths) {
    findings.push({
      code: 'TESTPATH_MISSING',
      severity: 'warning',
      message: `testpaths lists "${path}", which does not exist, so a bare pytest run collects nothing from it.`,
      suggestion: `Create ${path} or correct testpaths in ${input.sources[0] ?? 'the pytest configuration'}.`,
    });
  }

  if (input.sources.length === 0 && input.hasTestFiles) {
    findings.push({
      code: 'PYTEST_NOT_CONFIGURED',
      severity: 'info',
      message:
        'No pytest configuration was found: pytest runs with defaults, so testpaths and plugin options are not pinned anywhere.',
    });
  }

  return findings;
}
