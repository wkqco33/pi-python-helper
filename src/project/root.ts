import { access, stat } from 'node:fs/promises';
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
