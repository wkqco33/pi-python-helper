/**
 * Where pytest configuration can live. `pyproject.toml` is read by the scanner
 * (tomllib) and passed in already-decided; the INI files have to be inspected
 * here because only `pytest.ini` is unambiguously a pytest file.
 */
export interface PytestConfiguration {
  configured: boolean;
  /** Files that define pytest configuration, in the order they were checked. */
  sources: string[];
}

export interface PytestConfigurationInput {
  /** True when pyproject.toml has a `[tool.pytest.ini_options]` table. */
  pyprojectConfigured: boolean;
  /**
   * Raw contents of `pytest.ini`, `tox.ini`, and `setup.cfg`, keyed by file
   * name. A missing key means the file does not exist.
   */
  iniFiles: Record<string, string | undefined>;
}

/** `[pytest]` (pytest.ini) and `[tool:pytest]` (setup.cfg / tox.ini). */
const PYTEST_SECTION = /^\s*\[(?:tool:)?pytest\]\s*$/m;

/**
 * Deciding whether pytest is configured used to look at `pyproject.toml`
 * alone, which reports "not configured" for every project that keeps
 * `pytest.ini` — the file pytest itself recommends.
 *
 * `pytest.ini` counts on existence because it has no other purpose. `tox.ini`
 * and `setup.cfg` are shared files, so they only count when they actually carry
 * a pytest section.
 */
export function detectPytestConfiguration(input: PytestConfigurationInput): PytestConfiguration {
  const sources: string[] = [];
  if (input.pyprojectConfigured) sources.push('pyproject.toml');

  for (const name of ['pytest.ini', 'tox.ini', 'setup.cfg']) {
    const content = input.iniFiles[name];
    if (content === undefined) continue;
    if (name === 'pytest.ini' || PYTEST_SECTION.test(content)) sources.push(name);
  }

  return { configured: sources.length > 0, sources };
}
