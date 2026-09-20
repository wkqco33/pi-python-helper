import { basename, dirname, join } from 'node:path';
import { isPythonFile, isTestFile, parentDir, pathTokens, toPosix } from '../project/paths.ts';

export interface TestSelection {
  path: string;
  score: number;
  reason: string;
}

export interface SelectionResult {
  selected: TestSelection[];
  /** True when no changed file could be mapped and every test file is returned. */
  fellBackToAll: boolean;
  changedSourceFiles: string[];
  changedTestFiles: string[];
  consideredTestFiles: string[];
}

const SCORE = {
  changedTestItself: 100,
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
 * Rank test files against changed paths using pytest conventions first and
 * token overlap second. The convention signals are strong enough in Python that
 * a name match should always outrank a fuzzy token match.
 */
export function selectTests(changedPaths: string[], testFiles: string[]): SelectionResult {
  const changed = changedPaths.map(toPosix).filter(isPythonFile);
  const changedSourceFiles = changed.filter((path) => !isTestFile(path));
  const changedTestFiles = changed.filter(isTestFile);
  const considered = [...new Set(testFiles.map(toPosix).filter(isPythonFile))].sort();

  if (!changed.length) {
    return {
      selected: [],
      fellBackToAll: false,
      changedSourceFiles,
      changedTestFiles,
      consideredTestFiles: considered,
    };
  }

  const sourceTokens = new Set(changedSourceFiles.flatMap(pathTokens));
  const sourceModules = new Set(changedSourceFiles.map(firstImportableSegment));
  const sourceDirs = new Set(changedSourceFiles.map(parentDir));
  const sourceStems = new Set(changedSourceFiles.map(normalizedStem));

  const selections: TestSelection[] = [];
  for (const testFile of considered) {
    const reasons: string[] = [];
    let score = 0;

    if (changedTestFiles.includes(testFile)) {
      score += SCORE.changedTestItself;
      reasons.push('the test file itself changed');
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
    if (module && sourceModules.has(module)) {
      score += SCORE.sharedModule;
      reasons.push(`covers module "${module}"`);
    }

    const tokens = pathTokens(testFile);
    const shared = tokens.filter((token) => sourceTokens.has(token));
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

  const fellBackToAll = selections.length === 0 && considered.length > 0;
  return {
    selected: fellBackToAll
      ? considered.map((path) => ({ path, score: 0, reason: 'no match; running the full suite' }))
      : selections,
    fellBackToAll,
    changedSourceFiles,
    changedTestFiles,
    consideredTestFiles: considered,
  };
}
