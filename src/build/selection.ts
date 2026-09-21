/**
 * Python's test-selection signals over the shared ranking algorithm.
 *
 * The ranking (pytest naming conventions first, fuzzy token overlap second,
 * ubiquitous signals discarded) lives in `pi-helper-core`. This module answers
 * only the Python questions: what is a source/test file, what module a path
 * becomes, and what counts as shared test infrastructure.
 */
import { selectTests as coreSelectTests, type SelectionSignals } from 'pi-helper-core';
import {
  isPythonFile,
  isRunnableTestFile,
  isTestFile,
  pathTokens,
  toPosix,
} from '../project/paths.ts';

export type {
  SelectionOptions,
  SelectionResult,
  TestImportMap,
  TestSelection,
} from 'pi-helper-core';

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

const PYTHON_SIGNALS: SelectionSignals = {
  isSourceFile: isPythonFile,
  isTestFile,
  isRunnableTestFile,
  pathTokens,
  moduleNamesForFile: modulePathsFromFile,
  packageName: firstImportableSegment,
  supportFileNames: new Set(['conftest.py']),
  testNameAffixes: { prefixes: ['test_'], suffixes: ['_test'] },
};

export function selectTests(
  changedPaths: string[],
  testFiles: string[],
  options: import('pi-helper-core').SelectionOptions = {},
): import('pi-helper-core').SelectionResult {
  return coreSelectTests(changedPaths, testFiles, PYTHON_SIGNALS, options);
}
