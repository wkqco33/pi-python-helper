import { type Diagnostic, type Suggestion, warn } from '../core/result.ts';
import {
  compareInstalledConformance,
  requiredDeclarationsFrom,
  type ConformanceReport,
} from './conformance.ts';
import type { InstalledEnvironment } from './installed.ts';
import type { PytestConfiguration } from './pytest-config.ts';
import type { LockComparison, LockSection, ManifestSection, ScanPayload } from './scanner.ts';

export interface ProjectInspection {
  root: string;
  pyproject?: string;
  uvLock?: string;
  venvDir?: string;
  name?: string;
  version?: string;
  requiresPython?: string;
  layout: 'src' | 'flat';
  modules: string[];
  importName?: string;
  buildBackend?: string;
  entryPoints: string[];
  toolConfiguration: Record<string, boolean>;
  uvWorkspaceMembers: string[];
  uvSources: string[];
  requirementsFiles: string[];
  dependencyCounts: {
    runtime: number;
    optional: Record<string, number>;
    groups: Record<string, number>;
  };
  lock: { present: boolean; path?: string; packageCount: number };
  /** Lock-versus-installed comparison; `undefined` when no environment was scanned. */
  conformance?: ConformanceReport;
  installed?: { sitePackages: string; count: number; editableCount: number };
  warnings: Diagnostic[];
  notes: Diagnostic[];
  suggestions: Suggestion[];
}

export interface InspectInput {
  payload: ScanPayload;
  venvDir?: string;
  /** `undefined` when no .gitignore exists, so the check stays honest. */
  venvIgnored?: boolean;
  hasTestsDirectory: boolean;
  /** Test directories found relative to the root; names them in the diagnostic. */
  testDirectories?: string[];
  /**
   * Where pytest configuration was found. The scanner only reads
   * `pyproject.toml`, so INI files are decided by the caller.
   */
  pytestConfiguration?: PytestConfiguration;
  /** Distributions read from `.venv`; omit to skip the conformance comparison. */
  installed?: InstalledEnvironment;
}

interface DiagnosticCollector {
  warnings: Diagnostic[];
  notes: Diagnostic[];
  suggestions: Suggestion[];
}

function collectManifestDiagnostics(
  manifest: ManifestSection | null | undefined,
  root: string,
  collector: DiagnosticCollector,
): void {
  if (manifest?.tomlError) {
    collector.warnings.push(
      warn('TOML_PARSE_ERROR', manifest.tomlError, manifest.pyprojectPath ?? undefined),
    );
  }
  for (const message of manifest?.warnings ?? []) {
    collector.warnings.push(
      warn('MANIFEST_WARNING', message, manifest?.pyprojectPath ?? undefined),
    );
  }

  if (!manifest?.pyprojectPath) {
    collector.warnings.push(
      warn(
        'PYPROJECT_MISSING',
        'pyproject.toml was not found; dependencies, layout, and tool configuration cannot be verified.',
      ),
    );
    collector.suggestions.push({
      message: 'Run uv init to create a pyproject.toml, then uv add the runtime dependencies.',
      confidence: 'high',
      command: 'uv init',
    });
  } else if (!manifest.name) {
    collector.warnings.push(
      warn(
        'PROJECT_NAME_MISSING',
        'pyproject.toml has no [project] name, so the installed distribution name is unknown.',
        manifest.pyprojectPath ?? undefined,
      ),
    );
    collector.suggestions.push({
      message: 'Add a [project] table with name and version to pyproject.toml.',
      confidence: 'high',
    });
  }

  if (manifest?.legacySetupPy || manifest?.legacySetupCfg) {
    collector.warnings.push(
      warn(
        'LEGACY_PACKAGING',
        `The project still uses ${[
          manifest.legacySetupPy ? 'setup.py' : '',
          manifest.legacySetupCfg ? 'setup.cfg' : '',
        ]
          .filter(Boolean)
          .join(' and ')}; uv reads dependency metadata from pyproject.toml only.`,
        root,
      ),
    );
    collector.suggestions.push({
      message: 'Move dependency metadata from setup.py/setup.cfg into [project] in pyproject.toml.',
      confidence: 'medium',
    });
  }

  if (manifest?.requirementsFiles.length && manifest.pyprojectPath) {
    collector.warnings.push(
      warn(
        'DUPLICATE_DEPENDENCY_SOURCE',
        `${manifest.requirementsFiles.join(', ')} also declares dependencies; uv resolves from pyproject.toml and uv.lock only.`,
        root,
      ),
    );
  }

  if (manifest?.legacySetupPy && manifest.buildBackend === null && !manifest.pyprojectPath) {
    collector.suggestions.push({
      message: 'uv manages dependencies from pyproject.toml; migrate before running uv sync.',
      confidence: 'medium',
    });
  }
}

function collectLockDiagnostics(
  lock: LockSection | null | undefined,
  comparison: LockComparison | null | undefined,
  collector: DiagnosticCollector,
): void {
  for (const message of lock?.warnings ?? []) {
    collector.notes.push({ code: 'LOCKFILE_NOTE', message, severity: 'info' });
  }

  if (!lock?.present) {
    collector.notes.push({
      code: 'LOCKFILE_MISSING',
      message:
        'uv.lock was not found, so dependency drift and exact resolved versions cannot be verified.',
      severity: 'info',
    });
    collector.suggestions.push({
      message: 'Run uv lock to record resolved versions in uv.lock.',
      confidence: 'high',
      command: 'uv lock',
    });
  }

  if (comparison?.requiresPythonMismatch) {
    collector.warnings.push(
      warn(
        'REQUIRES_PYTHON_MISMATCH',
        `pyproject.toml requires-python is "${comparison.requiresPythonMismatch.manifest}" but uv.lock records "${comparison.requiresPythonMismatch.lock}".`,
        lock?.path ?? undefined,
      ),
    );
    collector.suggestions.push({
      message: 'Run uv lock so the lockfile reflects the current requires-python constraint.',
      confidence: 'high',
      command: 'uv lock',
    });
  }

  for (const name of comparison?.missingFromLock ?? []) {
    collector.warnings.push(
      warn(
        'LOCKFILE_MISSING_DEPENDENCY',
        `"${name}" is declared in pyproject.toml but absent from uv.lock.`,
        lock?.path ?? undefined,
      ),
    );
  }
  if (comparison?.missingFromLock.length) {
    collector.suggestions.push({
      message: 'Run uv lock to add the missing declarations to the lockfile.',
      confidence: 'high',
      command: 'uv lock',
    });
  }

  for (const entry of comparison?.unsatisfiedInLock ?? []) {
    collector.warnings.push(
      warn(
        'LOCKFILE_UNSATISFIED_DEPENDENCY',
        `"${entry.name}" is locked at ${entry.locked} which does not satisfy "${entry.specifier}".`,
        lock?.path ?? undefined,
      ),
    );
  }

  if (lock?.present && comparison && !comparison.specifierCheckAvailable) {
    collector.notes.push({
      code: 'SPECIFIER_CHECK_UNAVAILABLE',
      message:
        'The packaging library was unavailable, so only declared-versus-locked names were compared, not version constraints.',
      severity: 'info',
    });
    collector.suggestions.push({
      message:
        'Install the packaging library in the analysing interpreter to compare declared version constraints against uv.lock.',
      confidence: 'medium',
      command: 'python3 -m pip install packaging',
    });
  }
}

function collectEnvironmentDiagnostics(
  root: string,
  manifest: ManifestSection | null | undefined,
  venvDir: string | undefined,
  venvIgnored: boolean | undefined,
  hasTestsDirectory: boolean,
  testDirectories: string[] | undefined,
  pytestConfiguration: PytestConfiguration | undefined,
  collector: DiagnosticCollector,
): void {
  if (!venvDir) {
    collector.notes.push({
      code: 'VENV_MISSING',
      message: 'No .venv directory exists at the project root; run uv sync before running tests.',
      severity: 'info',
    });
  } else if (venvIgnored === false) {
    collector.warnings.push(
      warn(
        'VENV_NOT_IGNORED',
        '.venv exists but is not listed in .gitignore.',
        `${root}/.gitignore`,
      ),
    );
    collector.suggestions.push({
      message: 'Add .venv/ to .gitignore so the environment is never committed.',
      confidence: 'high',
    });
  }

  if (!hasTestsDirectory) {
    collector.notes.push({
      code: 'TESTS_DIRECTORY_MISSING',
      message:
        'No tests directory was found in the project root or inside a top-level package, so test selection and TDD gates cannot match changed sources.',
      severity: 'info',
    });
  } else if (testDirectories && testDirectories.length > 0) {
    collector.notes.push({
      code: 'TESTS_DIRECTORY_FOUND',
      message: `Tests live in ${testDirectories.slice(0, 4).join(', ')}${testDirectories.length > 4 ? `, … (+${testDirectories.length - 4})` : ''}. Confirm testpaths covers them when running pytest without a target.`,
      severity: 'info',
    });
  }

  // pytest can be configured from pytest.ini, tox.ini, or setup.cfg, not only
  // from pyproject.toml; checking one file reported "not configured" for most
  // projects that use pytest's own configuration file.
  const pytestConfigured =
    pytestConfiguration?.configured ?? manifest?.toolConfiguration?.pytest === true;
  if (manifest?.pyprojectPath && !pytestConfigured) {
    collector.notes.push({
      code: 'PYTEST_NOT_CONFIGURED',
      message:
        'No pytest configuration was found in pyproject.toml, pytest.ini, tox.ini, or setup.cfg.',
      severity: 'info',
    });
  }

  if (manifest?.layout === 'src' && manifest.modules.length === 0) {
    collector.warnings.push(
      warn(
        'EMPTY_SRC_LAYOUT',
        'The src/ directory exists but contains no importable module directories or modules.',
        `${root}/src`,
      ),
    );
  }

  if (manifest?.uvWorkspaceMembers.length) {
    collector.notes.push({
      code: 'UV_WORKSPACE',
      message: `This is a uv workspace with ${manifest.uvWorkspaceMembers.length} member(s); scope build and test tools per member.`,
      severity: 'info',
    });
  }
}

/**
 * Turn a scanner payload into a project model plus diagnostics. Pure so the
 * whole diagnostic surface is unit-testable without touching a filesystem.
 */
export function inspectProject(input: InspectInput): ProjectInspection {
  const {
    payload,
    venvDir,
    venvIgnored,
    hasTestsDirectory,
    testDirectories,
    pytestConfiguration,
    installed,
  } = input;
  const manifest = payload.manifest;
  const lock = payload.lock;
  const comparison = payload.lockComparison;
  const root = payload.root;

  const collector: DiagnosticCollector = { warnings: [], notes: [], suggestions: [] };
  collectManifestDiagnostics(manifest, root, collector);
  collectLockDiagnostics(lock, comparison, collector);
  collectEnvironmentDiagnostics(
    root,
    manifest,
    venvDir,
    venvIgnored,
    hasTestsDirectory,
    testDirectories,
    pytestConfiguration,
    collector,
  );

  const { warnings, notes, suggestions } = collector;

  const conformance =
    installed !== undefined
      ? compareInstalledConformance({
          lock,
          installed,
          projectName: manifest?.name ?? undefined,
          requiredDeclarations: requiredDeclarationsFrom(manifest),
        })
      : undefined;
  if (conformance) {
    warnings.push(...conformance.warnings);
    notes.push(...conformance.notes);
    if (conformance.findings.some((finding) => finding.code === 'PROJECT_NOT_INSTALLED')) {
      suggestions.push({
        message:
          'The project is recorded as an editable install but is missing from .venv. Run uv sync; if that fails, the build backend could not find the package (check that the module directory name matches [project] name).',
        confidence: 'high',
        command: 'uv sync',
      });
    }
    if (
      conformance.findings.some(
        (finding) =>
          finding.code === 'INSTALLED_VERSION_MISMATCH' ||
          finding.code === 'INSTALLED_PACKAGE_MISSING' ||
          finding.code === 'PROJECT_INSTALLED_NOT_EDITABLE',
      )
    ) {
      suggestions.push({
        message: 'Synchronise .venv with the lockfile so tests run against the locked versions.',
        confidence: 'high',
        command: 'uv sync --frozen',
      });
    }
  }

  const optionalCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(manifest?.optionalDependencies ?? {})) {
    optionalCounts[key] = value.length;
  }
  const groupCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(manifest?.dependencyGroups ?? {})) {
    groupCounts[key] = value.length;
  }

  return {
    root,
    pyproject: manifest?.pyprojectPath ?? undefined,
    uvLock: lock?.present ? (lock.path ?? undefined) : undefined,
    venvDir,
    name: manifest?.name ?? undefined,
    version: manifest?.version ?? undefined,
    requiresPython: manifest?.requiresPython ?? undefined,
    layout: manifest?.layout ?? 'flat',
    modules: manifest?.modules ?? [],
    importName: manifest?.importName,
    buildBackend: manifest?.buildBackend ?? undefined,
    entryPoints: manifest?.entryPoints ?? [],
    toolConfiguration: manifest?.toolConfiguration ?? {},
    uvWorkspaceMembers: manifest?.uvWorkspaceMembers ?? [],
    uvSources: manifest?.uvSources ?? [],
    requirementsFiles: manifest?.requirementsFiles ?? [],
    dependencyCounts: {
      runtime: manifest?.dependencies.length ?? 0,
      optional: optionalCounts,
      groups: groupCounts,
    },
    lock: {
      present: lock?.present ?? false,
      path: lock?.path ?? undefined,
      packageCount: lock?.packages.length ?? 0,
    },
    conformance,
    installed:
      installed !== undefined
        ? {
            sitePackages: installed.sitePackages,
            count: installed.count,
            editableCount: installed.distributions.filter((entry) => entry.source === 'editable')
              .length,
          }
        : undefined,
    warnings,
    notes,
    suggestions,
  };
}
