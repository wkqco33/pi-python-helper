import { isTestFile } from '../project/paths.ts';

export interface TddCheckpoint {
  ok: boolean;
  reasons: string[];
  sourceChanges: string[];
  testChanges: string[];
}

const MIN_TOKEN_LENGTH = 4;

function tokens(path: string): string[] {
  return path
    .toLowerCase()
    .replace(/\.py$/, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH);
}

function related(source: string, test: string): boolean {
  const testTokens = tokens(test).filter((token) => token !== 'test' && token !== 'tests');
  return tokens(source).some((sourceToken) =>
    testTokens.some(
      (testToken) =>
        sourceToken === testToken ||
        sourceToken.startsWith(testToken) ||
        testToken.startsWith(sourceToken),
    ),
  );
}

/**
 * Check that production changes are accompanied by a plausibly related test
 * change. Matching is name-based on purpose: it is cheap, deterministic, and
 * only used to decide whether to run the heavier verification bundle.
 */
export function checkTdd(changedPaths: string[], testChangedPaths: string[] = []): TddCheckpoint {
  const all = [...new Set([...changedPaths, ...testChangedPaths])].map((path) =>
    path.replace(/\\/g, '/'),
  );
  const sourceChanges = all.filter((path) => path.endsWith('.py') && !isTestFile(path));
  const testChanges = all.filter((path) => path.endsWith('.py') && isTestFile(path));

  const hasRelatedTest =
    testChanges.length > 0
      ? sourceChanges.some((source) => testChanges.some((test) => related(source, test)))
      : false;

  const reasons: string[] = [];
  if (sourceChanges.length > 0 && testChanges.length === 0) {
    reasons.push('Production Python files changed without any test file change.');
  } else if (sourceChanges.length > 0 && !hasRelatedTest) {
    reasons.push('Changed test files do not appear related to the changed production modules.');
  }

  return {
    ok: reasons.length === 0,
    reasons,
    sourceChanges,
    testChanges,
  };
}
