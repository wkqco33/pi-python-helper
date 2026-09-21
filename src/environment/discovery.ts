import { type Diagnostic, warn } from '../core/result.ts';
import { runCommand } from '../core/runner.ts';
import { findProjectRoot, findVenvDir, isFile } from '../project/root.ts';
import {
  type EnvironmentSection,
  type LockPackage,
  resolveProjectInterpreter,
  runScanProject,
} from '../project/scanner.ts';
import { inspectTools, type ToolAvailability } from './tools.ts';

export interface PythonEnvironment {
  interpreter?: string;
  /**
   * Whether the analysed interpreter belongs to the project environment or was
   * taken from PATH. Analysis facts such as `site-packages` contents and the
   * reported version are only the project's when this is `venv`.
   */
  interpreterOrigin?: 'venv' | 'path';
  python?: EnvironmentSection;
  projectRoot?: string;
  venvDir?: string;
  uv: { available: boolean; version?: string; lockPresent: boolean };
  tools: ToolAvailability[];
  warnings: Diagnostic[];
  suggestions: string[];
}

function parseVersion(output: string): string | undefined {
  const match = output.match(/(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)/);
  return match?.[1];
}

/**
 * Report the version of a host CLI. Reserved for `uv`, which cannot be resolved
 * from the project lockfile; project tools get their version from `uv.lock`.
 */
export async function toolVersion(
  cwd: string,
  name: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const run = await runCommand(name, ['--version'], {
    cwd,
    signal,
    timeoutMs: 5000,
    maxBytes: 4096,
  });
  if (run.code !== 0) return undefined;
  return parseVersion(`${run.stdout}\n${run.stderr}`);
}

/**
 * Describe the interpreter, project root, environment, and tool availability.
 *
 * A single bounded scanner call supplies both the interpreter facts and the
 * lockfile, so availability is resolved from filesystem probes plus the
 * lockfile instead of one subprocess per tool.
 */
export async function detectPythonEnvironment(
  cwd: string,
  signal?: AbortSignal,
): Promise<PythonEnvironment> {
  const warnings: Diagnostic[] = [];
  const suggestions: string[] = [];
  const projectRoot = await findProjectRoot(cwd);
  const scanRoot = projectRoot ?? cwd;

  let python: EnvironmentSection | undefined;
  let lockPackages: LockPackage[] = [];
  const resolved = await resolveProjectInterpreter(scanRoot, cwd, signal);
  const interpreter = resolved.interpreter;
  if (interpreter) {
    const scan = await runScanProject(
      cwd,
      { root: scanRoot, mode: 'environment,manifest' },
      signal,
    );
    if (scan.ok) {
      python = scan.payload?.environment;
      lockPackages = scan.payload?.lock?.packages ?? [];
    } else if (scan.message) {
      warnings.push(warn(scan.code ?? 'SCANNER_FAILED', scan.message));
    }
  } else {
    warnings.push(
      warn(
        'PYTHON_NOT_FOUND',
        'No Python 3 interpreter was found in the project environment or on PATH; every analysis tool degrades to static inspection only.',
      ),
    );
    suggestions.push('Install Python 3.11 or newer so pyproject.toml and uv.lock can be parsed.');
  }

  if (!projectRoot) {
    warnings.push(
      warn(
        'PROJECT_NOT_FOUND',
        'No pyproject.toml, uv.lock, or setup.py was found from this directory.',
      ),
    );
    suggestions.push(
      'Run uv init to create a uv-managed project, or change to an existing project directory.',
    );
  }

  const venvDir = projectRoot ? await findVenvDir(projectRoot) : undefined;
  const lockPresent = projectRoot ? await isFile(`${projectRoot}/uv.lock`) : false;
  const tools = await inspectTools({ venvDir, lockPackages });

  // A distribution recorded in the lockfile is installable, not installed. When
  // the project environment exists but a declared tool has no console script,
  // the environment was synced without it and every later step that needs it
  // will fail, so this is reported rather than left to be discovered later.
  const missingDeclaredTools = venvDir ? tools.filter((tool) => tool.installable) : [];
  if (missingDeclaredTools.length > 0) {
    const names = missingDeclaredTools.map((tool) => tool.name).join(', ');
    warnings.push(
      warn(
        'TOOL_NOT_INSTALLED',
        `${names} ${missingDeclaredTools.length === 1 ? 'is' : 'are'} recorded in uv.lock but has no executable in .venv, so it cannot be run right now.`,
        venvDir,
      ),
    );
    suggestions.push(
      'Run uv sync --frozen --all-groups --all-extras: a plain uv sync removes extras declared in [project.optional-dependencies].',
    );
  }

  const uvVersion = await toolVersion(cwd, 'uv', signal);
  if (!uvVersion) {
    warnings.push(
      warn(
        'UV_NOT_AVAILABLE',
        'The uv CLI was not found on PATH; commands cannot be previewed reliably.',
      ),
    );
    suggestions.push('Install uv (https://docs.astral.sh/uv/) before build or test operations.');
  }

  if (projectRoot && python && !python.inVirtualEnvironment && !venvDir) {
    warnings.push(
      warn(
        'NO_VIRTUAL_ENVIRONMENT',
        'The resolved interpreter is not inside a virtual environment and no .venv directory exists at the project root.',
      ),
    );
    suggestions.push('Run uv sync to create .venv and install the locked dependencies.');
  }

  if (projectRoot && python && python.inVirtualEnvironment && venvDir && python.virtualEnv) {
    const active = python.virtualEnv.replace(/\/+$/, '');
    if (active !== venvDir) {
      warnings.push(
        warn(
          'VIRTUAL_ENVIRONMENT_MISMATCH',
          `VIRTUAL_ENV points at ${active} but the project environment is ${venvDir}.`,
        ),
      );
      suggestions.push(
        'Deactivate the unrelated environment, or run uv sync to refresh the project .venv.',
      );
    }
  }

  if (python && !python.tomlAvailable) {
    warnings.push(
      warn(
        'TOML_PARSER_UNAVAILABLE',
        `Python ${python.version} has no tomllib; pyproject.toml and uv.lock analysis is degraded.`,
      ),
    );
    suggestions.push(
      'Use Python 3.11+ (or install tomli in the analysing interpreter) to enable manifest analysis.',
    );
  }

  if (projectRoot && !lockPresent) {
    suggestions.push('Run uv lock to create uv.lock so dependency drift can be detected.');
  }

  return {
    interpreter,
    interpreterOrigin: resolved.origin,
    python,
    projectRoot,
    venvDir,
    uv: { available: uvVersion !== undefined, version: uvVersion, lockPresent },
    tools,
    warnings,
    suggestions,
  };
}
