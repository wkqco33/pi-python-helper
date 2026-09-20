import { basename, dirname } from 'node:path';

export function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

export function isPythonFile(path: string): boolean {
  return toPosix(path).endsWith('.py');
}

const TEST_DIRECTORY = /(^|\/)(tests?|testing)(\/|$)/i;
const TEST_FILENAME = /(^|\/)(test_[^/]+|[^/]+_test)\.py$/i;

/**
 * pytest conventions only: a `tests/` directory, a `test_*.py` / `*_test.py`
 * module, or a conftest. Everything else counts as production code.
 */
export function isTestFile(path: string): boolean {
  const posix = toPosix(path);
  if (basename(posix) === 'conftest.py') return true;
  return TEST_DIRECTORY.test(posix) || TEST_FILENAME.test(posix);
}

export function isSourceFile(path: string): boolean {
  return isPythonFile(path) && !isTestFile(path);
}

/** Directory that contains the file, without a trailing slash. */
export function parentDir(path: string): string {
  const posix = toPosix(path);
  const index = posix.lastIndexOf('/');
  return index === -1 ? '' : posix.slice(0, index);
}

/**
 * Meaningful tokens of a path: directory and file stems, split on case
 * boundaries and punctuation, with generic segments removed.
 */
const GENERIC = new Set([
  'src',
  'lib',
  'app',
  'apps',
  'pkg',
  'packages',
  'python',
  'test',
  'tests',
  'testing',
  'unit',
  'integration',
  'py',
  'init',
  'main',
  'demo',
]);

export function pathTokens(path: string): string[] {
  return toPosix(path)
    .replace(/\.py$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3 && !GENERIC.has(token));
}

/** Importable top-level module a source path belongs to, when discoverable. */
export function moduleNameFromPath(path: string): string | undefined {
  const segments = toPosix(path).split('/');
  const index = segments.lastIndexOf('src');
  if (index !== -1 && segments.length > index + 2) return segments[index + 1];
  if (segments.length > 1 && !isTestFile(path)) return segments[0];
  return undefined;
}
