import { type Diagnostic, warn } from '../core/result.ts';
import type { InstalledEnvironment } from './installed.ts';
import { normalizeDistributionName } from './installed.ts';
import type { LockPackage, LockSection, ManifestSection } from './scanner.ts';

/**
 * Declared dependencies that `uv sync` installs without extra flags:
 * `[project] dependencies` plus the default `dev` dependency group. Optional
 * extras are excluded because a plain sync never installs them.
 */
export function requiredDeclarationsFrom(
  manifest: ManifestSection | undefined,
  defaultGroup = 'dev',
): { name: string; normalized: string; marker: string | null }[] {
  if (!manifest) return [];
  const groups = [manifest.dependencies, manifest.dependencyGroups[defaultGroup] ?? []];
  return groups.flatMap((list) =>
    list.map((dependency) => ({
      name: dependency.name,
      normalized: dependency.normalized,
      marker: dependency.marker,
    })),
  );
}

export type ConformanceCode =
  | 'INSTALLED_VERSION_MISMATCH'
  | 'INSTALLED_PACKAGE_MISSING'
  | 'INSTALLED_PACKAGE_UNTRACKED'
  | 'INSTALLED_ENVIRONMENT_INDEPENDENT'
  | 'PROJECT_NOT_INSTALLED'
  | 'PROJECT_INSTALLED_NOT_EDITABLE';

export interface ConformanceFinding {
  code: ConformanceCode;
  message: string;
  name: string;
  expected?: string;
  actual?: string;
}

export interface ConformanceReport {
  verdict: 'consistent' | 'drifted' | 'unverifiable';
  /** False whenever the comparison could not cover every distribution. */
  complete: boolean;
  reason: string;
  checks: {
    venvPresent: boolean;
    lockPresent: boolean;
    installedScanned: boolean;
    projectInstalled: boolean | null;
    projectEditable: boolean | null;
  };
  counts: {
    lockPackages: number;
    installedPackages: number;
    mismatched: number;
    missing: number;
    /** Locked entries that are conditional for this platform and correctly absent. */
    conditional: number;
    untracked: number;
  };
  findings: ConformanceFinding[];
  warnings: Diagnostic[];
  notes: Diagnostic[];
}

/**
 * Untracked packages are only reported individually while they look like an
 * anomaly. Hundreds of them mean the environment is not managed by this
 * lockfile at all (a shared or conda environment), which deserves one summary
 * instead of a wall of warnings.
 */
const INDEPENDENT_ENVIRONMENT_MIN = 20;
const INDEPENDENT_ENVIRONMENT_RATIO = 0.5;

/** Lock entries that are a local project rather than an index download. */
function isLocalProjectEntry(package_: LockPackage): boolean {
  return package_.source === 'editable' || package_.source === 'virtual';
}

/** The entry that represents the project this command is running in. */
function isRootProjectEntry(package_: LockPackage, projectName: string | undefined): boolean {
  if (!isLocalProjectEntry(package_)) return false;
  if (!projectName) return true;
  return package_.normalized === normalizeDistributionName(projectName);
}

export interface ConformanceInput {
  lock?: LockSection;
  installed?: InstalledEnvironment;
  projectName?: string;
  /**
   * Declared dependencies that `uv sync` installs without extra flags:
   * `[project] dependencies` plus the default `dev` group. Used to decide
   * whether an absent locked package is genuinely missing.
   */
  requiredDeclarations?: { name: string; normalized: string; marker: string | null }[];
}

/**
 * Names that must be installed: a declaration with no marker, or an edge
 * without a marker coming from the root project or from a package that is
 * itself installed. Everything else is platform- or version-conditional and is
 * correctly absent, so its absence is not drift.
 */
function requiredInstalledNames(
  lock: LockSection,
  installedNormalized: Set<string>,
  input: ConformanceInput,
): Set<string> {
  const required = new Set<string>();
  for (const declaration of input.requiredDeclarations ?? []) {
    if (declaration.marker === null) required.add(declaration.normalized);
  }
  for (const entry of lock.packages) {
    const isReachableSource =
      isRootProjectEntry(entry, input.projectName) || installedNormalized.has(entry.normalized);
    if (!isReachableSource) continue;
    for (const edge of entry.dependencies ?? []) {
      if (edge.marker === null) required.add(edge.normalized);
    }
  }
  return required;
}

/**
 * Compare the three sources of truth that describe a Python environment:
 * what `pyproject.toml` declares, what `uv.lock` resolved, and what is actually
 * present in `.venv`.
 *
 * Only the lock-versus-installed leg is computed here; declared-versus-lock is
 * reported by the manifest drift check, so the two never duplicate a finding.
 */
export function compareInstalledConformance(input: ConformanceInput): ConformanceReport {
  const { lock, installed, projectName } = input;
  const findings: ConformanceFinding[] = [];
  const warnings: Diagnostic[] = [];
  const notes: Diagnostic[] = [];
  const venvPresent = installed !== undefined;
  const lockPresent = lock?.present ?? false;
  const installedPackages = installed?.count ?? 0;

  const checks = {
    venvPresent,
    lockPresent,
    installedScanned: venvPresent,
    projectInstalled: null as boolean | null,
    projectEditable: null as boolean | null,
  };
  const counts = {
    lockPackages: lock?.packages.length ?? 0,
    installedPackages,
    mismatched: 0,
    missing: 0,
    conditional: 0,
    untracked: 0,
  };

  for (const message of installed?.warnings ?? []) {
    warnings.push(warn('INSTALLED_SCAN_WARNING', message));
  }

  const unverifiable = (reason: string): ConformanceReport => ({
    verdict: 'unverifiable',
    complete: false,
    reason,
    checks,
    counts,
    findings,
    warnings,
    notes,
  });

  if (!venvPresent) {
    return unverifiable(
      'No .venv with a site-packages directory was found, so installed versions cannot be compared with uv.lock.',
    );
  }
  if (!lockPresent || !lock) {
    return unverifiable(
      'uv.lock is missing, so there is no expected version set to compare the installed distributions against.',
    );
  }

  const installedByNormalized = new Map(
    (installed?.distributions ?? []).map((entry) => [entry.normalized, entry]),
  );
  const lockByNormalized = new Map(lock.packages.map((entry) => [entry.normalized, entry]));
  const required = requiredInstalledNames(lock, new Set(installedByNormalized.keys()), input);
  const conditionalAbsent: string[] = [];

  for (const entry of lock.packages) {
    const actual = installedByNormalized.get(entry.normalized);
    const localProject = isLocalProjectEntry(entry);
    const rootProject = isRootProjectEntry(entry, projectName);

    if (!actual) {
      if (localProject) {
        counts.missing += 1;
        if (rootProject) checks.projectInstalled = false;
        findings.push({
          code: 'PROJECT_NOT_INSTALLED',
          name: entry.name,
          expected: entry.version ?? undefined,
          message: rootProject
            ? `uv.lock records "${entry.name}" as an editable install, but it is absent from .venv. The project is not importable and no test can exercise it.`
            : `uv.lock records the local project "${entry.name}" as an editable install, but it is absent from .venv.`,
        });
      } else if (required.has(entry.normalized)) {
        counts.missing += 1;
        findings.push({
          code: 'INSTALLED_PACKAGE_MISSING',
          name: entry.name,
          expected: entry.version ?? undefined,
          message: `"${entry.name}" is locked and required unconditionally, but it is not installed in .venv.`,
        });
      } else {
        // Guarded by a platform or version marker, so this platform rightly omits it.
        counts.conditional += 1;
        conditionalAbsent.push(`${entry.name}@${entry.version ?? '?'}`);
      }
      continue;
    }

    if (localProject) {
      if (rootProject) checks.projectInstalled = true;
      if (actual.source !== 'editable') {
        if (rootProject) checks.projectEditable = false;
        findings.push({
          code: 'PROJECT_INSTALLED_NOT_EDITABLE',
          name: entry.name,
          actual: actual.version,
          message: rootProject
            ? `"${entry.name}" is installed from a materialised copy instead of an editable link, so tests would import a stale snapshot of the sources.`
            : `The local project "${entry.name}" is installed from a materialised copy instead of an editable link.`,
        });
      } else if (rootProject) {
        checks.projectEditable = true;
      }
      // The editable version tracks pyproject.toml, so a version difference here
      // is lockfile drift and is reported by the manifest check instead.
      continue;
    }

    if (entry.version && actual.version !== entry.version) {
      counts.mismatched += 1;
      findings.push({
        code: 'INSTALLED_VERSION_MISMATCH',
        name: entry.name,
        expected: entry.version,
        actual: actual.version,
        message: `"${entry.name}" is locked at ${entry.version} but ${actual.version} is installed in .venv.`,
      });
    }
  }

  const untrackedCandidates = (installed?.distributions ?? []).filter(
    (entry) => !entry.bootstrap && !lockByNormalized.has(entry.normalized),
  );
  const nonBootstrap = (installed?.distributions ?? []).filter((entry) => !entry.bootstrap).length;

  if (
    untrackedCandidates.length >= INDEPENDENT_ENVIRONMENT_MIN &&
    nonBootstrap > 0 &&
    untrackedCandidates.length / nonBootstrap > INDEPENDENT_ENVIRONMENT_RATIO
  ) {
    counts.untracked = untrackedCandidates.length;
    findings.push({
      code: 'INSTALLED_ENVIRONMENT_INDEPENDENT',
      name: installed?.sitePackages ?? '',
      actual: String(untrackedCandidates.length),
      message: `${untrackedCandidates.length} of ${nonBootstrap} installed distributions are absent from uv.lock, which suggests .venv was not created by uv for this project.`,
    });
  } else {
    for (const entry of untrackedCandidates) {
      counts.untracked += 1;
      findings.push({
        code: 'INSTALLED_PACKAGE_UNTRACKED',
        name: entry.name,
        actual: entry.version,
        message: `"${entry.name}" ${entry.version} is installed in .venv but is absent from uv.lock (${entry.source === 'editable' ? 'editable install' : 'installed copy'}).`,
      });
    }
  }

  if (conditionalAbsent.length > 0) {
    notes.push({
      code: 'CONDITIONAL_PACKAGES_ABSENT',
      message: `${conditionalAbsent.length} locked distribution(s) are guarded by a platform or version marker and are correctly absent here: ${conditionalAbsent.slice(0, 8).join(', ')}${conditionalAbsent.length > 8 ? ', …' : ''}.`,
      severity: 'info',
    });
  }

  const bootstrapCount = (installed?.distributions ?? []).filter((entry) => entry.bootstrap).length;
  if (bootstrapCount > 0) {
    notes.push({
      code: 'BOOTSTRAP_DISTRIBUTIONS_SKIPPED',
      message: `${bootstrapCount} interpreter-seeded distribution(s) (pip/setuptools and similar) were excluded from the comparison.`,
      severity: 'info',
    });
  }
  const recovered = (installed?.distributions ?? []).filter(
    (entry) => entry.recoveredFromDirectory,
  ).length;
  if (recovered > 0) {
    notes.push({
      code: 'VERSION_FROM_DIRECTORY_NAME',
      message: `${recovered} distribution(s) had no readable METADATA version; the version came from the dist-info directory name.`,
      severity: 'info',
    });
  }

  for (const finding of findings) {
    warnings.push(warn(finding.code, finding.message));
  }

  const complete = !(installed?.truncated ?? false);
  if (!complete) {
    notes.push({
      code: 'CONFORMANCE_INCOMPLETE',
      message:
        'The installed-distribution scan was truncated, so the comparison does not cover the whole environment.',
      severity: 'info',
    });
  }

  const drifted = findings.length > 0;
  return {
    verdict: drifted ? 'drifted' : complete ? 'consistent' : 'unverifiable',
    complete,
    reason: drifted
      ? `${findings.length} environment conformance problem(s) found: ${counts.mismatched} version mismatch(es), ${counts.missing} missing, ${counts.untracked} untracked.`
      : complete
        ? `All ${counts.lockPackages - counts.conditional} unconditional locked distribution(s) match the ${installedPackages} installed distribution(s)${counts.conditional > 0 ? ` (${counts.conditional} conditional entry/entries correctly absent)` : ''}.`
        : 'The lock and installed distributions agree where they could be compared, but the scan was truncated.',
    checks,
    counts,
    findings,
    warnings,
    notes,
  };
}
