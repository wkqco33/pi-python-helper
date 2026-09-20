import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from '../core/runner.ts';
import { gitDiffNames, gitStatusPorcelain } from './commands.ts';

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
  'site-packages',
]);

const MAX_WALKED_FILES = 5000;

/** Walk the project for Python files, skipping environments and caches. */
export async function listPythonFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0 && files.length < MAX_WALKED_FILES) {
    const directory = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= MAX_WALKED_FILES) break;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.endsWith('.egg-info')) continue;
        stack.push(path);
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        files.push(
          path
            .slice(root.length)
            .replace(/^[/\\]/, '')
            .replace(/\\/g, '/'),
        );
      }
    }
  }
  return files.sort();
}

export async function listTestFiles(root: string): Promise<string[]> {
  const { isTestFile } = await import('../project/paths.ts');
  return (await listPythonFiles(root)).filter(isTestFile);
}

export interface ChangedPathsResult {
  paths: string[];
  source: 'git' | 'none';
  error?: string;
}

/**
 * Collect changed paths from git, including untracked files so a brand new test
 * file is considered. Falls back to an empty list outside a repository.
 */
export async function changedPaths(cwd: string, signal?: AbortSignal): Promise<ChangedPathsResult> {
  const diff = await runCommand('git', gitDiffNames(cwd).args, {
    cwd,
    signal,
    timeoutMs: 10000,
    maxBytes: 200_000,
  });
  if (diff.code !== 0) {
    return { paths: [], source: 'none', error: diff.stderr.trim() || 'git diff failed' };
  }
  const status = await runCommand('git', gitStatusPorcelain(cwd).args, {
    cwd,
    signal,
    timeoutMs: 10000,
    maxBytes: 200_000,
  });
  const untracked =
    status.code === 0
      ? status.stdout
          .split(/\r?\n/)
          .filter((line) => line.startsWith('??'))
          .map((line) => line.slice(3).trim())
      : [];
  const paths = [...diff.stdout.split(/\r?\n/), ...untracked]
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { paths: [...new Set(paths)], source: 'git' };
}
