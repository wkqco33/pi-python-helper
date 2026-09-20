import { type Diagnostic, warn } from '../core/result.ts';
import { runCommand } from '../core/runner.ts';
import { findProjectRoot, findVenvDir, exists, isFile } from '../project/root.ts';
import { type EnvironmentSection, resolveInterpreter, runScanProject } from '../project/scanner.ts';

/** Tools the extension reports on. Lint/type diagnostics are delegated elsewhere. */
const PROBED_TOOLS = ['uv', 'ruff', 'mypy', 'ty', 'pyright', 'pytest', 'pre-commit'] as const;

export interface ToolAvailability {
  name: string;
  available: boolean;
  version?: string;
  /** Tools that the project should invoke through `uv run` rather than directly. */
  preferredInvocation: string;
}

export interface PythonEnvironment {
  interpreter?: string;
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
 * Every probe is bounded and independent: a missing tool is reported as an
 * availability fact rather than an error.
 */
export async function detectPythonEnvironment(
  cwd: string,
  signal?: AbortSignal,
): Promise<PythonEnvironment> {
  const warnings: Diagnostic[] = [];
  const suggestions: string[] = [];
  const interpreter = await resolveInterpreter(cwd, signal);
  const projectRoot = await findProjectRoot(cwd);

  const probed = await Promise.all(
    PROBED_TOOLS.map(async (name) => {
      const version = await toolVersion(cwd, name, signal);
      return {
        name,
        available: version !== undefined,
        version,
        preferredInvocation: name === 'uv' ? 'uv' : `uv run --frozen ${name}`,
      } satisfies ToolAvailability;
    }),
  );
  const uvEntry = probed.find((entry) => entry.name === 'uv');

  let python: EnvironmentSection | undefined;
  if (interpreter) {
    const scan = await runScanProject(
      cwd,
      { root: projectRoot ?? cwd, mode: 'environment' },
      signal,
    );
    if (scan.ok) python = scan.payload?.environment;
    else if (scan.message) warnings.push(warn(scan.code ?? 'SCANNER_FAILED', scan.message));
  } else {
    warnings.push(
      warn(
        'PYTHON_NOT_FOUND',
        'No Python 3 interpreter was found on PATH; every analysis tool degrades to static inspection only.',
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

  if (!uvEntry?.available) {
    warnings.push(
      warn(
        'UV_NOT_AVAILABLE',
        'The uv CLI was not found on PATH; commands cannot be previewed reliably.',
      ),
    );
    suggestions.push('Install uv (https://docs.astral.sh/uv/) before build or test operations.');
  }

  const venvDir = projectRoot ? await findVenvDir(projectRoot) : undefined;
  const lockPresent = projectRoot ? await isFile(`${projectRoot}/uv.lock`) : false;

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
    python,
    projectRoot,
    venvDir,
    uv: { available: uvEntry?.available ?? false, version: uvEntry?.version, lockPresent },
    tools: probed,
    warnings,
    suggestions,
  };
}

export async function hasFile(path: string): Promise<boolean> {
  return exists(path);
}
