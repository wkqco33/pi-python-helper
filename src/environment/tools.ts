import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { normalizeDistributionName } from '../project/installed.ts';
import type { LockPackage } from '../project/scanner.ts';

/**
 * Tools worth reporting to the agent. Lint and type diagnostics are delegated
 * to other extensions, but the agent still needs to know whether the project
 * environment provides these executables.
 */
export const DEFAULT_PROBED_TOOLS = [
  'pytest',
  'ruff',
  'mypy',
  'ty',
  'pyright',
  'pre-commit',
] as const;

export type ToolVersionSource = 'lock' | 'cli' | 'unknown';

export interface ToolAvailability {
  name: string;
  /**
   * True only when a runnable executable was found right now.
   *
   * A distribution recorded in `uv.lock` is *installable*, not available: the
   * environment may have had it removed. Reporting it as available made a
   * broken virtual environment look healthy.
   */
  available: boolean;
  /** True when `uv.lock` records the distribution, so `uv sync` can install it. */
  declared: boolean;
  /** True when `uv sync` would provide the tool that is not runnable yet. */
  installable: boolean;
  /** True when the console script was found inside the project environment. */
  installed: boolean;
  /** Absolute path when an executable was found. */
  executable?: string;
  /** Where the executable was found: the project environment or the host PATH. */
  origin?: 'venv' | 'path';
  version?: string;
  versionSource: ToolVersionSource;
  preferredInvocation: string;
}

const WINDOWS = process.platform === 'win32';
const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat', '.ps1'];

function executableNames(name: string): string[] {
  return WINDOWS ? WINDOWS_EXTENSIONS.map((extension) => `${name}${extension}`) : [name];
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    if (WINDOWS) return true;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a console script inside a virtual environment. uv puts scripts in `bin`
 * on POSIX and `Scripts` on Windows; both are checked so a project analysed on
 * either platform reports the same tools.
 */
export async function findVenvScript(venvDir: string, name: string): Promise<string | undefined> {
  const directories = WINDOWS
    ? [join(venvDir, 'Scripts'), join(venvDir, 'bin')]
    : [join(venvDir, 'bin'), join(venvDir, 'Scripts')];
  for (const directory of directories) {
    for (const candidate of executableNames(name)) {
      const path = join(directory, candidate);
      if (await isExecutableFile(path)) return path;
    }
  }
  return undefined;
}

/** Resolve an executable on PATH without spawning a process. */
export async function resolveOnPath(
  name: string,
  pathValue: string = process.env.PATH ?? '',
): Promise<string | undefined> {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const candidate of executableNames(name)) {
      const path = join(directory, candidate);
      if (await isExecutableFile(path)) return path;
    }
  }
  return undefined;
}

/** Versions the lockfile pins, keyed by normalized distribution name. */
export function lockedVersions(lockPackages: LockPackage[] | undefined): Map<string, string> {
  const versions = new Map<string, string>();
  for (const entry of lockPackages ?? []) {
    if (entry.version) versions.set(entry.normalized, entry.version);
  }
  return versions;
}

export interface ToolProbeInput {
  venvDir?: string;
  lockPackages?: LockPackage[];
  names?: readonly string[];
  pathValue?: string;
}

/**
 * Report which tools the project can run, using only filesystem probes and the
 * already-parsed lockfile.
 *
 * Executing `--version` per tool was the single largest cost in
 * `py_environment` (pytest alone spent 154 ms importing itself), and it reported
 * the *host* version rather than the one the project will use. The lockfile is
 * the authoritative source for a project tool, and PATH or `.venv/bin`
 * presence answers the availability question without a subprocess.
 */
export async function inspectTools(input: ToolProbeInput = {}): Promise<ToolAvailability[]> {
  const names = input.names ?? DEFAULT_PROBED_TOOLS;
  const locked = lockedVersions(input.lockPackages);

  return Promise.all(
    names.map(async (name) => {
      const normalized = normalizeDistributionName(name);
      const venvScript = input.venvDir ? await findVenvScript(input.venvDir, name) : undefined;
      const pathScript = venvScript ? undefined : await resolveOnPath(name, input.pathValue);
      const lockVersion = locked.get(normalized);
      const executable = venvScript ?? pathScript;
      const origin = venvScript ? 'venv' : pathScript ? 'path' : undefined;

      return {
        name,
        available: Boolean(executable),
        declared: lockVersion !== undefined,
        installable: lockVersion !== undefined && !executable,
        installed: venvScript !== undefined,
        executable,
        origin,
        version: lockVersion,
        versionSource: lockVersion ? 'lock' : 'unknown',
        preferredInvocation: `uv run --frozen ${name}`,
      } satisfies ToolAvailability;
    }),
  );
}

export interface RequiredToolCheck {
  /** False when there was no project environment to inspect at all. */
  checked: boolean;
  venvDir?: string;
  /** Names with no console script in the project environment. */
  missing: string[];
}

/**
 * Confirm that the tools a later step depends on are runnable *now*.
 *
 * `uv sync` can legitimately finish with exit code 0 while removing the very
 * tools the next step needs, so the environment is re-checked between the two
 * instead of trusting the exit code.
 */
export async function checkRequiredTools(
  venvDir: string | undefined,
  names: readonly string[],
): Promise<RequiredToolCheck> {
  if (!venvDir) return { checked: false, missing: [] };
  const missing: string[] = [];
  for (const name of names) {
    if (!(await findVenvScript(venvDir, name))) missing.push(name);
  }
  return { checked: true, venvDir, missing };
}
