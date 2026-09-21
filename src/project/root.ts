import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Files that mark the root of a uv-managed Python project. */
const ROOT_MARKERS = ['pyproject.toml', 'uv.lock', 'setup.py', 'setup.cfg'];

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the project root from a directory. `pyproject.toml` and `uv.lock`
 * win over the legacy markers, so a repository that contains a nested uv
 * project still resolves to that nested project when the search starts inside
 * it.
 */
export async function findProjectRoot(start: string): Promise<string | undefined> {
  let current = resolve(start);
  let fallback: string | undefined;
  while (true) {
    if (await isFile(join(current, 'pyproject.toml'))) return current;
    if (await isFile(join(current, 'uv.lock'))) return current;
    for (const marker of ROOT_MARKERS) {
      if (await isFile(join(current, marker))) fallback ??= current;
    }
    const parent = dirname(current);
    if (parent === current) return fallback;
    current = parent;
  }
}

/** Locate the virtual environment uv would create for the project. */
export async function findVenvDir(root: string): Promise<string | undefined> {
  const candidate = join(root, '.venv');
  return (await isDirectory(candidate)) ? candidate : undefined;
}

const TEST_DIRECTORY_NAMES = new Set(['test', 'tests', 'testing']);

/** Directories that can never contain the project's own tests. */
const UNSCANNABLE_DIRECTORIES = new Set([
  '.git',
  '.venv',
  'venv',
  '.tox',
  '.nox',
  '__pycache__',
  'node_modules',
  'build',
  'dist',
  '.eggs',
  '.mypy_cache',
  '.ruff_cache',
  '.pytest_cache',
]);

/**
 * Find the directories that hold tests, relative to the project root.
 *
 * Looking only for `./tests` misses the common layout where the suite lives
 * inside the package it tests (`<package>/tests/`), which made the tool claim a
 * project with hundreds of tests had none.
 */
export async function findTestDirectories(root: string, maxDepth = 3): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string, relative: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name.startsWith('.')) continue;
      const childRelative = relative ? `${relative}/${name}` : name;
      if (TEST_DIRECTORY_NAMES.has(name)) {
        found.push(childRelative);
        continue;
      }
      if (UNSCANNABLE_DIRECTORIES.has(name)) continue;
      if (depth < maxDepth) await walk(join(directory, name), childRelative, depth + 1);
    }
  };
  await walk(root, '', 1);
  return found;
}

const WINDOWS = process.platform === 'win32';

/**
 * Locate the interpreter inside a project virtual environment.
 *
 * The interpreter that runs the read-only scanner decides which
 * `site-packages` it can see: a host `python3` maps four modules while the
 * project's own interpreter maps the whole environment, so asking the wrong one
 * makes every import name look like it has no providing distribution.
 */
export async function findVenvInterpreter(venvDir: string): Promise<string | undefined> {
  const directories = WINDOWS
    ? [join(venvDir, 'Scripts'), join(venvDir, 'bin')]
    : [join(venvDir, 'bin'), join(venvDir, 'Scripts')];
  const names = WINDOWS ? ['python.exe', 'python'] : ['python', 'python3'];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        const info = await stat(candidate);
        if (!info.isFile()) continue;
        if (!WINDOWS) await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

export async function isGitIgnored(root: string, entry: string): Promise<boolean | undefined> {
  const gitignore = join(root, '.gitignore');
  try {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(gitignore, 'utf8');
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .some((line) => line.replace(/^\//, '').replace(/\/$/, '') === entry);
  } catch {
    return undefined;
  }
}
