import type { CommandPreview } from '../core/result.ts';

/**
 * uv invocations are built as argument arrays rather than shell strings so user
 * supplied paths can never be interpreted by a shell. `--frozen` is used
 * everywhere a lockfile exists: it forbids implicit re-resolution so a test run
 * cannot silently rewrite uv.lock.
 */
export function uvLockCheck(cwd: string, frozen = true): CommandPreview {
  return {
    executable: 'uv',
    args: frozen ? ['lock', '--check', '--offline'] : ['lock', '--check'],
    cwd,
    risk: 'read',
  };
}

export function uvLock(cwd: string): CommandPreview {
  return { executable: 'uv', args: ['lock'], cwd, risk: 'mutating' };
}

export interface UvSyncOptions {
  /**
   * `all` requests every extra declared in `[project.optional-dependencies]`.
   *
   * `uv sync --all-groups` covers `[dependency-groups]` only, so a project that
   * declares pytest/ruff/pyright as an extra has them **removed** by a plain
   * sync. Installing more than needed is recoverable; deleting the project's
   * own dev tooling mid-run is not, so extras are requested by default.
   */
  extras?: 'all' | 'none';
}

export function uvSyncFrozen(cwd: string, options: UvSyncOptions = {}): CommandPreview {
  const extras = options.extras ?? 'all';
  const args = ['sync', '--frozen', '--all-groups'];
  if (extras === 'all') args.push('--all-extras');
  return { executable: 'uv', args, cwd, risk: 'mutating' };
}

export function uvRun(cwd: string, args: string[]): CommandPreview {
  return { executable: 'uv', args: ['run', '--frozen', ...args], cwd, risk: 'read' };
}

export interface PytestOptions {
  targets?: string[];
  lastFailed?: boolean;
  keyword?: string;
  extraArgs?: string[];
  maxFail?: number;
}

export const PYTEST_BASE_ARGS = ['-q', '--tb=short', '-rf', '--no-header'];

/**
 * pytest always runs through `uv run --frozen` so the project environment is
 * used even when the shell was never activated.
 */
export function pytestCommand(cwd: string, options: PytestOptions = {}): CommandPreview {
  const args = [...PYTEST_BASE_ARGS];
  if (options.lastFailed) args.push('--lf');
  if (options.keyword) args.push('-k', options.keyword);
  if (options.maxFail !== undefined) args.push('--maxfail', String(options.maxFail));
  args.push(...(options.extraArgs ?? []));
  args.push(...(options.targets ?? []));
  return uvRun(cwd, ['pytest', ...args]);
}

export function gitDiffNames(cwd: string, args: string[] = ['--name-only']): CommandPreview {
  return { executable: 'git', args: ['diff', ...args, 'HEAD'], cwd, risk: 'read' };
}

export function gitStatusPorcelain(cwd: string): CommandPreview {
  return {
    executable: 'git',
    args: ['status', '--porcelain', '--untracked-files=all'],
    cwd,
    risk: 'read',
  };
}
