import { basename, dirname, join } from 'node:path';
import {
  isPythonFile,
  isRunnableTestFile,
  isTestFile,
  parentDir,
  pathTokens,
  toPosix,
} from '../project/paths.ts';

export interface TestSelection {
  path: string;
  score: number;
  reason: string;
}

export interface SelectionResult {
  selected: TestSelection[];
  /** True when no changed file could be mapped and every test file is returned. */
  fellBackToAll: boolean;
  /**
   * False when the selection covers every considered test file, so the
   * candidate list was not narrowed at all. Reported so a caller does not read
   * "30 of 30 selected" as a focused run.
   */
  narrowed: boolean;
  changedSourceFiles: string[];
  changedTestFiles: string[];
  consideredTestFiles: string[];
  /** Files under a test directory that pytest does not collect tests from. */
  supportFiles: string[];
  /**
   * True when at least one candidate was matched by an actual import of a
   * changed module, which is the strongest available signal. False means the
   * selection rests on naming conventions alone.
   */
  importEvidenceUsed: boolean;
}

/**
 * Dotted module names imported by each test file, keyed by test path.
 * Supplied by the scanner because a test named `test_db_session.py` gives no
 * naming hint that it covers `db/database.py`; its imports do.
 */
export type TestImportMap = Record<string, string[]>;

export interface SelectionOptions {
  testImports?: TestImportMap;
}

const SCORE = {
  changedTestItself: 100,
  /** Importing the changed module is stronger than any name coincidence. */
  importsChangedModule: 90,
  sameStemSameDir: 80,
  sameStem: 60,
  sameDirectory: 40,
  sharedToken: 20,
  sharedModule: 30,
};

function stem(path: string): string {
  return basename(toPosix(path)).replace(/\.py$/i, '');
}

/** Strip the pytest prefix/suffix so `test_parser.py` and `parser.py` compare equal. */
function normalizedStem(path: string): string {
  return stem(path)
    .replace(/^test_/, '')
    .replace(/_test$/, '')
    .toLowerCase();
}

function firstImportableSegment(path: string): string {
  const segments = toPosix(path)
    .split('/')
    .filter((segment) => segment.length > 0);
  const index = segments.lastIndexOf('src');
  const start = index === -1 ? 0 : index + 1;
  return (segments[start] ?? '').replace(/\.py$/i, '').toLowerCase();
}

/**
 * Dotted module names a source path could be imported as.
 *
 * `src/pkg/db/database.py` is imported as `pkg.db.database`, and an
 * `__init__.py` is the package itself, so both forms are produced with and
 * without the `src/` prefix.
 */
export function modulePathsFromFile(path: string): string[] {
  const posix = toPosix(path);
  if (!isPythonFile(posix)) return [];
  const segments = posix.split('/').filter((segment) => segment.length > 0);
  const srcIndex = segments.lastIndexOf('src');
  const trimmed = (srcIndex === -1 ? segments : segments.slice(srcIndex + 1)).map((segment) =>
    segment.replace(/\.py$/i, ''),
  );
  if (trimmed.length === 0) return [];
  if (trimmed.at(-1) === '__init__') trimmed.pop();
  if (trimmed.length === 0) return [];
  const dotted = trimmed.join('.');
  const withoutRoot = trimmed.slice(1).join('.');
  const candidates = [dotted];
  if (srcIndex !== -1) candidates.push(segments.slice(srcIndex).join('.').replace(/\.py$/i, ''));
  if (withoutRoot.length > 0) candidates.push(withoutRoot);
  return [...new Set(candidates)];
}

/** True when a test imports the module, or a parent package of it. */
function importsModule(imported: string[], modules: string[]): string | undefined {
  let best: string | undefined;
  for (const candidate of modules) {
    for (const entry of imported) {
      const matches =
        entry === candidate ||
        entry.startsWith(`${candidate}.`) ||
        candidate.startsWith(`${entry}.`);
      if (!matches) continue;
      // Report the most specific import: naming `pkg` when the file actually
      // imports `pkg.routes.admin` overstates how broadly the test is coupled.
      if (!best || entry.length > best.length) best = entry;
    }
  }
  return best;
}

/**
 * Values that appear in at least this share of the candidates carry no
 * information about *which* candidate to run: in a project whose tests all live
 * inside the package under test, the package name matches every file.
 */
const UBIQUITOUS_SHARE = 0.5;

function ubiquitousValues(documents: string[][]): Set<string> {
  const counts = new Map<string, number>();
  for (const values of documents) {
    for (const value of new Set(values)) {
      if (value.length === 0) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  const threshold = Math.max(2, documents.length * UBIQUITOUS_SHARE);
  const ubiquitous = new Set<string>();
  for (const [value, count] of counts) {
    if (count >= threshold) ubiquitous.add(value);
  }
  return ubiquitous;
}

/**
 * Rank test files against changed paths using pytest conventions first and
 * token overlap second. The convention signals are strong enough in Python that
 * a name match should always outrank a fuzzy token match.
 *
 * Signals shared by every candidate are discarded rather than scored. Without
 * that step a package-rooted test tree (`<package>/tests/`) matches its own
 * package on every file and the selection degenerates into the full suite.
 */
export function selectTests(
  changedPaths: string[],
  testFiles: string[],
  options: SelectionOptions = {},
): SelectionResult {
  const changed = changedPaths.map(toPosix).filter(isPythonFile);
  const changedSourceFiles = changed.filter((path) => !isTestFile(path));
  const changedTestFiles = changed.filter(isTestFile);
  const considered = [...new Set(testFiles.map(toPosix).filter(isPythonFile))].sort();
  const supportFiles = considered.filter((path) => !isRunnableTestFile(path));
  const testImports = options.testImports ?? {};

  if (!changed.length) {
    return {
      selected: [],
      fellBackToAll: false,
      narrowed: false,
      changedSourceFiles,
      changedTestFiles,
      consideredTestFiles: considered,
      supportFiles,
      importEvidenceUsed: false,
    };
  }

  const sourceTokens = new Set(changedSourceFiles.flatMap(pathTokens));
  const sourceModules = new Set(changedSourceFiles.map(firstImportableSegment));
  const sourceStems = new Set(changedSourceFiles.map(normalizedStem));
  const sourceModulePaths = changedSourceFiles.map((path) => modulePathsFromFile(path));

  const ubiquitousTokens = ubiquitousValues(considered.map((path) => pathTokens(path)));
  const ubiquitousModules = ubiquitousValues(
    considered.map((path) => [firstImportableSegment(path)]),
  );
  // A source directory that contains every test file (the package root) cannot
  // distinguish candidates, so it does not score.
  const sourceDirs = new Set(
    [...new Set(changedSourceFiles.map(parentDir))].filter(
      (directory) =>
        directory === '' || !considered.every((path) => path.startsWith(`${directory}/`)),
    ),
  );

  let importEvidenceUsed = false;
  const selections: TestSelection[] = [];
  for (const testFile of considered) {
    // Test infrastructure is not a target, but it can still affect the run, so it
    // is reported separately instead of being scored as a test file.
    if (!isRunnableTestFile(testFile)) continue;

    const reasons: string[] = [];
    let score = 0;

    if (changedTestFiles.includes(testFile)) {
      score += SCORE.changedTestItself;
      reasons.push('the test file itself changed');
    }

    const imported = testImports[testFile];
    if (imported && imported.length > 0) {
      const matched = sourceModulePaths
        .map((modules) => importsModule(imported, modules))
        .find((value) => value !== undefined);
      if (matched) {
        score += SCORE.importsChangedModule;
        importEvidenceUsed = true;
        reasons.push(`imports the changed module "${matched}"`);
      }
    }

    const testStem = normalizedStem(testFile);
    const testDir = parentDir(testFile);
    if (sourceStems.has(testStem)) {
      score += SCORE.sameStem;
      reasons.push(`module name matches "${testStem}"`);
      if (sourceDirs.has(testDir)) {
        score += SCORE.sameStemSameDir - SCORE.sameStem;
        reasons.push('same directory as the changed module');
      }
    } else if (sourceDirs.has(testDir)) {
      score += SCORE.sameDirectory;
      reasons.push('same directory as a changed module');
    } else if (sourceDirs.has(dirname(testDir)) || sourceDirs.has(join(dirname(testDir), ''))) {
      score += SCORE.sameDirectory - 10;
      reasons.push('nested under a changed directory');
    }

    const module = firstImportableSegment(testFile);
    if (module && sourceModules.has(module) && !ubiquitousModules.has(module)) {
      score += SCORE.sharedModule;
      reasons.push(`covers module "${module}"`);
    }

    const tokens = pathTokens(testFile);
    const shared = tokens.filter(
      (token) => sourceTokens.has(token) && !ubiquitousTokens.has(token),
    );
    if (shared.length) {
      score += SCORE.sharedToken * Math.min(shared.length, 2);
      reasons.push(`shares token(s): ${shared.slice(0, 4).join(', ')}`);
    }

    if (score > 0) {
      selections.push({ path: testFile, score, reason: reasons.join('; ') });
    }
  }

  selections.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

  // A conftest can affect every test, so it is always in scope once tests run.
  for (const testFile of considered) {
    if (basename(testFile) === 'conftest.py' && !selections.some((s) => s.path === testFile)) {
      selections.push({ path: testFile, score: 1, reason: 'shared conftest fixture scope' });
    }
  }

  const runnableConsidered = considered.filter(isRunnableTestFile);
  const selectedRunnable = selections.filter((entry) => isRunnableTestFile(entry.path));
  const fellBackToAll = selections.length === 0 && considered.length > 0;
  if (fellBackToAll) {
    return {
      selected: considered.map((path) => ({
        path,
        score: 0,
        reason: 'no match; running the full suite',
      })),
      fellBackToAll: true,
      narrowed: false,
      changedSourceFiles,
      changedTestFiles,
      consideredTestFiles: considered,
      supportFiles,
      importEvidenceUsed,
    };
  }

  return {
    selected: selections,
    fellBackToAll: false,
    narrowed: selectedRunnable.length < runnableConsidered.length,
    changedSourceFiles,
    changedTestFiles,
    consideredTestFiles: considered,
    supportFiles,
    importEvidenceUsed,
  };
}
