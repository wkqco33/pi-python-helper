import { isTestFile } from '../project/paths.ts';

/** A production file and a test file that were matched to each other. */
export interface TddAssociation {
  source: string;
  test: string;
  /** Tokens both paths share, so the caller can judge the match. */
  sharedTokens: string[];
  /**
   * `module` when the match goes beyond the path prefix every file shares,
   * `package` when only the common package prefix matched. A package-level match
   * still passes the checkpoint, but it is weak evidence and is disclosed.
   */
  strength: 'module' | 'package';
}

export interface TddCheckpoint {
  ok: boolean;
  reasons: string[];
  sourceChanges: string[];
  testChanges: string[];
  associations: TddAssociation[];
  /** True when a match rested only on the shared package prefix. */
  weakAssociation: boolean;
}

/** Tokens shorter than this cannot distinguish two module names. */
const MIN_TOKEN_LENGTH = 4;

/** Tokens that appear in the prefix of every file and so carry no meaning. */
const PREFIX_TOKENS = new Set(['test', 'tests', 'testing', 'src', 'lib']);

function tokens(path: string): string[] {
  return path
    .replace(/\.py$/i, '')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= MIN_TOKEN_LENGTH && !PREFIX_TOKENS.has(token));
}

function sharedTokens(source: string, test: string): string[] {
  const testTokens = tokens(test);
  const shared: string[] = [];
  for (const sourceToken of new Set(tokens(source))) {
    if (
      testTokens.some(
        (testToken) =>
          sourceToken === testToken ||
          sourceToken.startsWith(testToken) ||
          testToken.startsWith(sourceToken),
      )
    ) {
      shared.push(sourceToken);
    }
  }
  return shared;
}

/**
 * Tokens contributed by the directory prefix every changed path shares.
 *
 * In a project whose tests live inside the package under test, every path starts
 * with the package name, so those tokens say nothing about whether a specific
 * test covers a specific module. A common prefix of nothing (no shared
 * directory) yields no exclusions, so an exact name match is never downgraded.
 */
function commonPrefixTokens(paths: string[]): Set<string> {
  if (paths.length < 2) return new Set();
  const directories = paths.map((path) => path.replace(/\\/g, '/').split('/').slice(0, -1));
  const [first, ...rest] = directories;
  const common: string[] = [];
  for (let index = 0; index < first.length; index += 1) {
    const segment = first[index];
    if (rest.every((entry) => entry[index] === segment)) common.push(segment);
    else break;
  }
  return new Set(common.flatMap((segment) => tokens(segment)));
}

/**
 * Check that production changes are accompanied by a plausibly related test
 * change.
 *
 * Matching is name-based on purpose: it is cheap, deterministic, and only used
 * to decide whether to run the heavier verification bundle. Because it is only
 * name-based, it also reports *why* each pair matched and downgrades a match
 * that rests solely on the package prefix instead of silently counting it as
 * strong evidence.
 */
export function checkTdd(changedPaths: string[], testChangedPaths: string[] = []): TddCheckpoint {
  const all = [...new Set([...changedPaths, ...testChangedPaths])].map((path) =>
    path.replace(/\\/g, '/'),
  );
  const sourceChanges = all.filter((path) => path.endsWith('.py') && !isTestFile(path));
  const testChanges = all.filter((path) => path.endsWith('.py') && isTestFile(path));

  // `fastapi_server/db/database.py` and `fastapi_server/tests/unit/test_db.py`
  // share `fastapi` and `server` with every other file in the project, so those
  // tokens must not be treated as evidence of a real relationship.
  const ubiquitous = commonPrefixTokens([...sourceChanges, ...testChanges]);

  const associations: TddAssociation[] = [];
  for (const source of sourceChanges) {
    for (const test of testChanges) {
      const shared = sharedTokens(source, test);
      if (shared.length === 0) continue;
      const discriminating = shared.filter((token) => !ubiquitous.has(token));
      associations.push({
        source,
        test,
        sharedTokens: shared,
        strength: discriminating.length > 0 ? 'module' : 'package',
      });
    }
  }

  const strong = associations.some((entry) => entry.strength === 'module');
  const weakAssociation = associations.length > 0 && !strong;

  const reasons: string[] = [];
  if (sourceChanges.length > 0 && testChanges.length === 0) {
    reasons.push('Production Python files changed without any test file change.');
  } else if (sourceChanges.length > 0 && associations.length === 0) {
    reasons.push('Changed test files do not appear related to the changed production modules.');
  }

  return {
    ok: reasons.length === 0,
    reasons,
    sourceChanges,
    testChanges,
    associations,
    weakAssociation,
  };
}
