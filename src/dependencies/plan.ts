import type { Diagnostic, Suggestion } from '../core/result.ts';
import { warn } from '../core/result.ts';
import { isTestFile } from '../project/paths.ts';
import type { DeclaredDependency, ScanPayload } from '../project/scanner.ts';

import { CONSOLE_ONLY, IMPORT_ALIASES } from './aliases.ts';
export { CONSOLE_ONLY, IMPORT_ALIASES };

const NORMALIZE_RE = /[-_.]+/g;

/** PEP 503 normalization: case and `-`/`_`/`.` are not significant. */
export function normalizeName(name: string): string {
  return name.replace(NORMALIZE_RE, '-').trim().toLowerCase();
}

export function distributionCandidates(importName: string, providers: string[]): string[] {
  const normalized = normalizeName(importName);
  const candidates = new Set<string>();
  for (const provider of providers) candidates.add(normalizeName(provider));
  for (const alias of IMPORT_ALIASES[importName] ?? []) candidates.add(normalizeName(alias));
  for (const alias of IMPORT_ALIASES[normalized] ?? []) candidates.add(normalizeName(alias));
  candidates.add(normalized);
  candidates.add(`python-${normalized}`);
  candidates.add(`${normalized}-python`);
  return [...candidates].filter((candidate) => candidate.length > 0);
}

export interface DeclaredEntry {
  name: string;
  normalized: string;
  groups: string[];
}

export type DependencyGroup = string;

export function buildDeclaredIndex(manifest: {
  dependencies: DeclaredDependency[];
  optionalDependencies: Record<string, DeclaredDependency[]>;
  dependencyGroups: Record<string, DeclaredDependency[]>;
}): Map<string, DeclaredEntry> {
  const index = new Map<string, DeclaredEntry>();
  const add = (dependency: DeclaredDependency, group: DependencyGroup) => {
    const normalized = normalizeName(dependency.normalized || dependency.name);
    const existing = index.get(normalized);
    if (existing) {
      if (!existing.groups.includes(group)) existing.groups.push(group);
      return;
    }
    index.set(normalized, { name: dependency.name, normalized, groups: [group] });
  };
  for (const dependency of manifest.dependencies) add(dependency, 'runtime');
  for (const [extra, list] of Object.entries(manifest.optionalDependencies)) {
    for (const dependency of list) add(dependency, `optional:${extra}`);
  }
  for (const [group, list] of Object.entries(manifest.dependencyGroups)) {
    for (const dependency of list) add(dependency, `group:${group}`);
  }
  return index;
}

export interface UndeclaredImport {
  import: string;
  files: string[];
  fileCount: number;
  providers: string[];
  /**
   * The distribution to declare, when the analysing interpreter could determine
   * it. Absent otherwise: `uv add <import name>` would then install a different
   * package, or nothing at all, because import names and distribution names
   * frequently disagree (`wconfig` ships inside `wpyconf`, `yaml` inside
   * `PyYAML`).
   */
  suggestedDistribution?: string;
  /** True when the suggestion comes from installed metadata rather than a guess. */
  providerKnown: boolean;
  typeCheckingOnly: boolean;
  reason: string;
}

export interface MisplacedDependency {
  import: string;
  distribution: string;
  declaredIn: string[];
  runtimeFiles: string[];
}

export interface UnusedDeclaration {
  name: string;
  normalized: string;
  groups: string[];
}

export interface DependencyPlan {
  declaredCount: number;
  declared: DeclaredEntry[];
  thirdPartyImportCount: number;
  undeclared: UndeclaredImport[];
  misplaced: MisplacedDependency[];
  unused: UnusedDeclaration[];
  drift: {
    lockPresent: boolean;
    missingFromLock: string[];
    unsatisfiedInLock: { name: string; specifier: string; locked: string }[];
    requiresPythonMismatch: { manifest: string; lock: string } | null;
  };
  providerMappingReliable: boolean;
  /**
   * Third-party imports the analysing interpreter could not map to an installed
   * distribution. A high count means the interpreter is not the project's own,
   * so "undeclared" may really be "import name differs from distribution name".
   */
  unmappedImports: number;
  unparsable: { path: string; error: string }[];
  warnings: Diagnostic[];
  notes: Diagnostic[];
  suggestions: Suggestion[];
}

export interface DependencyPlanOptions {
  /** Reporting declared-but-unimported packages produces false positives by design. */
  includeUnused?: boolean;
}

/**
 * Compare what the code imports with what the project declares.
 *
 * Three questions are answered, in decreasing confidence:
 * 1. an imported distribution that is declared nowhere,
 * 2. an imported distribution declared only in a dev group or extra while
 *    production code imports it, and
 * 3. an imported distribution missing from `uv.lock` or locked below its
 *    declared specifier.
 */
export function planDependencies(
  payload: ScanPayload,
  options: DependencyPlanOptions = {},
): DependencyPlan {
  const imports = payload.imports;
  const manifest = payload.manifest;
  const comparison = payload.lockComparison;
  const warnings: Diagnostic[] = [];
  const notes: Diagnostic[] = [];
  const suggestions: Suggestion[] = [];

  const declaredIndex = manifest ? buildDeclaredIndex(manifest) : new Map<string, DeclaredEntry>();

  const undeclared: UndeclaredImport[] = [];
  const misplaced: MisplacedDependency[] = [];
  const usedNormalized = new Set<string>();

  for (const entry of imports?.thirdParty ?? []) {
    const candidates = distributionCandidates(entry.import, entry.providers);
    const matched = candidates
      .map((candidate) => declaredIndex.get(candidate))
      .filter((value): value is DeclaredEntry => value !== undefined);
    for (const declaration of matched) usedNormalized.add(declaration.normalized);

    const typeCheckingFiles = new Set(entry.typeCheckingFiles ?? []);
    const runtimeFiles = entry.files.filter(
      (file) => !isTestFile(file) && !typeCheckingFiles.has(file),
    );
    const runtimeRelevant = !entry.typeCheckingOnly && runtimeFiles.length > 0;

    if (matched.length === 0) {
      // Prefer the distribution that actually owns the module. The static alias
      // table is a fallback for checkouts where nothing is installed.
      const suggested =
        entry.providers[0] ??
        IMPORT_ALIASES[entry.import]?.[0] ??
        IMPORT_ALIASES[normalizeName(entry.import)]?.[0];
      undeclared.push({
        import: entry.import,
        files: entry.files,
        fileCount: entry.fileCount,
        providers: entry.providers,
        suggestedDistribution: suggested,
        providerKnown: suggested !== undefined,
        typeCheckingOnly: entry.typeCheckingOnly,
        reason: entry.typeCheckingOnly
          ? 'imported only under TYPE_CHECKING and declared in neither [project] tables nor uv.lock'
          : 'imported by project code but declared in no dependency group',
      });
      continue;
    }

    const hasRuntimeDeclaration = matched.some((declaration) =>
      declaration.groups.includes('runtime'),
    );
    if (runtimeRelevant && !hasRuntimeDeclaration) {
      const groups = [...new Set(matched.flatMap((declaration) => declaration.groups))];
      misplaced.push({
        import: entry.import,
        distribution: matched[0].name,
        declaredIn: groups,
        runtimeFiles,
      });
    }
  }

  const unused: UnusedDeclaration[] = [];
  if (options.includeUnused) {
    for (const declaration of declaredIndex.values()) {
      if (usedNormalized.has(declaration.normalized)) continue;
      if (CONSOLE_ONLY.has(declaration.normalized)) continue;
      unused.push({
        name: declaration.name,
        normalized: declaration.normalized,
        groups: declaration.groups,
      });
    }
  }

  for (const entry of undeclared) {
    warnings.push(
      warn(
        entry.typeCheckingOnly ? 'UNDECLARED_TYPE_ONLY_IMPORT' : 'UNDECLARED_IMPORT',
        `"${entry.import}" is imported${entry.files.length ? ` in ${entry.files[0]}` : ''}${
          entry.fileCount > 1 ? ` and ${entry.fileCount - 1} other file(s)` : ''
        } but is declared in no dependency group.`,
        entry.files[0],
      ),
    );
    const distribution = entry.suggestedDistribution;
    if (distribution) {
      const flag = entry.typeCheckingOnly ? ' --dev' : '';
      suggestions.push({
        message: `Declare ${distribution} with uv add${flag} ${distribution}.`,
        confidence: entry.providers.length ? 'high' : 'medium',
        command: `uv add${flag} ${distribution}`,
      });
    } else {
      // Fabricating a command here would install the wrong package or fail.
      suggestions.push({
        message: `Look up the distribution that provides "${entry.import}" and declare that name: import names and distribution names frequently disagree, and the analysing interpreter could not map this one.`,
        confidence: 'low',
      });
    }
  }

  for (const entry of misplaced) {
    warnings.push(
      warn(
        'RUNTIME_DEPENDENCY_IN_DEV_GROUP',
        `"${entry.import}" is imported by production code (${entry.runtimeFiles[0]}) but "${entry.distribution}" is declared only in ${entry.declaredIn.join(', ')}.`,
        entry.runtimeFiles[0],
      ),
    );
    suggestions.push({
      message: `Move ${entry.distribution} from ${entry.declaredIn.join(', ')} into [project] dependencies.`,
      confidence: 'high',
      command: `uv add ${entry.distribution}`,
    });
  }

  for (const entry of unused) {
    notes.push({
      code: 'UNUSED_DECLARATION',
      message: `"${entry.name}" is declared in ${entry.groups.join(', ')} but no project file imports it (console-only tools are excluded; verify before removing).`,
      severity: 'info',
    });
  }

  const drift = {
    lockPresent: comparison !== undefined && (payload.lock?.present ?? false),
    missingFromLock: comparison?.missingFromLock ?? [],
    unsatisfiedInLock: comparison?.unsatisfiedInLock ?? [],
    requiresPythonMismatch: comparison?.requiresPythonMismatch ?? null,
  };
  if (drift.lockPresent && drift.missingFromLock.length + drift.unsatisfiedInLock.length > 0) {
    warnings.push(
      warn(
        'LOCKFILE_DRIFT',
        `uv.lock disagrees with pyproject.toml (${drift.missingFromLock.length} missing, ${
          drift.unsatisfiedInLock.length
        } unsatisfied). Run uv lock before trusting the environment.`,
        payload.lock?.path ?? undefined,
      ),
    );
    suggestions.push({
      message: 'Run uv lock to resynchronise uv.lock.',
      confidence: 'high',
      command: 'uv lock',
    });
  }

  const thirdPartyCount = imports?.thirdParty.length ?? 0;
  const unmappedImports = (imports?.thirdParty ?? []).filter(
    (entry) => entry.providers.length === 0,
  ).length;

  if (imports?.providersUnavailable) {
    notes.push({
      code: 'PROVIDER_MAPPING_HEURISTIC',
      message:
        'No installed distributions were visible to the analysing interpreter, so import-to-distribution mapping relied on a static alias table.',
      severity: 'info',
    });
  } else if (unmappedImports > 0) {
    notes.push({
      code: 'UNMAPPED_IMPORTS',
      message: `${unmappedImports} of ${thirdPartyCount} third-party import(s) could not be mapped to an installed distribution, so their distribution names are unknown rather than merely undeclared.`,
      severity: 'info',
    });
  }
  if (imports && !imports.stdlibAvailable) {
    notes.push({
      code: 'STDLIB_LIST_HEURISTIC',
      message:
        'The analysing interpreter predates sys.stdlib_module_names, so standard-library detection used a reduced list and third-party results may over-report.',
      severity: 'info',
    });
  }

  for (const entry of imports?.unparsable ?? []) {
    notes.push({
      code: 'UNPARSABLE_FILE',
      message: `${entry.path} could not be parsed: ${entry.error}`,
      severity: 'info',
      path: entry.path,
    });
  }

  return {
    declaredCount: declaredIndex.size,
    declared: [...declaredIndex.values()].sort((left, right) =>
      left.normalized.localeCompare(right.normalized),
    ),
    thirdPartyImportCount: imports?.thirdParty.length ?? 0,
    undeclared,
    misplaced,
    unused,
    drift,
    // A partial mapping is disclosed through `unmappedImports`; the claim here is
    // only that the interpreter could see an installed environment at all. When
    // it could see one yet owned none of the project's imports, it is not the
    // project's interpreter and nothing it reports should be trusted.
    providerMappingReliable:
      !(imports?.providersUnavailable ?? true) &&
      !(thirdPartyCount > 0 && unmappedImports === thirdPartyCount),
    unmappedImports,
    unparsable: imports?.unparsable ?? [],
    warnings,
    notes,
    suggestions,
  };
}
