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
  /** True when the tool is runnable, either locally or through `uv run`. */
  available: boolean;
  /** True when `uv.lock` records the distribution, so `uv sync` can install it. */
  declared: boolean;
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
        available: Boolean(executable) || lockVersion !== undefined,
        declared: lockVersion !== undefined,
        executable,
        origin,
        version: lockVersion,
        versionSource: lockVersion ? 'lock' : 'unknown',
        preferredInvocation: `uv run --frozen ${name}`,
      } satisfies ToolAvailability;
    }),
  );
}
