import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface StaleArtifact {
  code: 'STALE_COVERAGE_DATA';
  message: string;
  path: string;
  artifactMtimeMs?: number;
  newestSource?: { path: string; mtimeMs: number };
}

export interface PythonStalenessReport {
  stale: boolean;
  artifacts: StaleArtifact[];
  /** Populated when the check could not be completed, so `stale: false` is not overclaimed. */
  incompleteReason?: string;
}

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.venv',
  'venv',
  '.tox',
  '.nox',
  '__pycache__',
  '.mypy_cache',
  '.ruff_cache',
  '.pytest_cache',
  'node_modules',
  'build',
  'dist',
  '.eggs',
]);

const MAX_WALKED_FILES = 5000;

async function mtimeMs(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function newestPythonSource(
  root: string,
): Promise<{ path: string; mtimeMs: number } | undefined> {
  let newest: { path: string; mtimeMs: number } | undefined;
  let visited = 0;
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited > MAX_WALKED_FILES) return newest;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        stack.push(path);
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        visited += 1;
        const modified = await mtimeMs(path);
        if (modified === undefined) continue;
        if (!newest || modified > newest.mtimeMs) newest = { path, mtimeMs: modified };
      }
    }
  }
  return newest;
}

/**
 * Detect a coverage report that predates the sources it claims to describe.
 *
 * Python invalidates bytecode automatically and pytest installs nothing, so a
 * stale report is the one artifact that can make a passing run describe the
 * wrong code. Whether the project itself is installed as a stale copy is a
 * structural question and is answered by the environment conformance check
 * rather than by comparing mtimes here.
 */
export async function detectStaleArtifacts(root: string): Promise<PythonStalenessReport> {
  const artifacts: StaleArtifact[] = [];
  let newestSource: { path: string; mtimeMs: number } | undefined;
  try {
    newestSource = await newestPythonSource(root);
  } catch (error) {
    return {
      stale: false,
      artifacts,
      incompleteReason: `Source scan failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!newestSource) {
    return { stale: false, artifacts, incompleteReason: 'No Python source files were found.' };
  }

  for (const name of ['.coverage', 'coverage.xml']) {
    const path = join(root, name);
    const modified = await mtimeMs(path);
    if (modified === undefined) continue;
    if (modified < newestSource.mtimeMs) {
      artifacts.push({
        code: 'STALE_COVERAGE_DATA',
        message: `${name} was written before ${newestSource.path} changed; coverage results do not describe the current sources.`,
        path,
        artifactMtimeMs: modified,
        newestSource,
      });
    }
  }

  return { stale: artifacts.length > 0, artifacts };
}
