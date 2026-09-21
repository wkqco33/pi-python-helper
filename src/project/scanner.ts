import { runCommand } from '../core/runner.ts';
import { findVenvDir, findVenvInterpreter } from './root.ts';

export const HELPER_URL = new URL('../../helpers/scan_project.py', import.meta.url);

/** Sections the scanner can produce. A comma-separated combination is allowed. */
export type ScanMode =
  | 'environment'
  | 'manifest'
  | 'imports'
  | 'all'
  | 'environment,manifest'
  | 'environment,imports'
  | 'manifest,imports';

/** Bumped by the scanner when the request or result document changes shape. */
export const SUPPORTED_SCANNER_VERSION = 2;

export interface DeclaredDependency {
  raw: string;
  name: string;
  normalized: string;
  specifier: string;
  extras: string[];
  marker: string | null;
}

export interface ManifestSection {
  pyprojectPath: string | null;
  name: string | null;
  version: string | null;
  requiresPython: string | null;
  description: string | null;
  license: string | null;
  importName?: string;
  dependencies: DeclaredDependency[];
  optionalDependencies: Record<string, DeclaredDependency[]>;
  dependencyGroups: Record<string, DeclaredDependency[]>;
  buildBackend: string | null;
  buildRequires: string[];
  entryPoints: string[];
  toolConfiguration: Record<string, boolean>;
  layout: 'src' | 'flat';
  modules: string[];
  legacySetupPy: boolean;
  legacySetupCfg: boolean;
  requirementsFiles: string[];
  uvWorkspaceMembers: string[];
  uvSources: string[];
  warnings: string[];
  tomlError?: string;
}

export interface LockDependencyEdge {
  name: string;
  normalized: string;
  /** Non-null when uv only includes this dependency under a platform/version condition. */
  marker: string | null;
}

export interface LockPackage {
  name: string;
  normalized: string;
  version: string | null;
  source: string | null;
  dependencies?: LockDependencyEdge[];
}

export interface LockSection {
  path: string | null;
  present: boolean;
  version: unknown;
  revision: unknown;
  requiresPython: string | null;
  packages: LockPackage[];
  warnings: string[];
}

export interface LockComparison {
  specifierCheckAvailable: boolean;
  missingFromLock: string[];
  unsatisfiedInLock: { name: string; specifier: string; locked: string }[];
  requiresPythonMismatch: { manifest: string; lock: string } | null;
  checkedCount: number;
}

export interface ImportSection {
  pythonVersion: string;
  stdlibAvailable: boolean;
  layout: 'src' | 'flat';
  localModules: string[];
  files: {
    path: string;
    imports: string[];
    /**
     * Full dotted module names the file references, so a test file can be
     * matched to the module it imports rather than only by file name.
     */
    importModules?: string[];
    typeCheckingImports: string[];
  }[];
  thirdParty: {
    import: string;
    files: string[];
    fileCount: number;
    providers: string[];
    /** True when every importing file guards the import behind TYPE_CHECKING. */
    typeCheckingOnly: boolean;
    typeCheckingFiles: string[];
  }[];
  providersUnavailable: boolean;
  unparsable: { path: string; error: string }[];
  scannedFiles: number;
  truncated: boolean;
}

export interface EnvironmentSection {
  version: string;
  versionInfo: number[];
  executable: string;
  prefix: string;
  basePrefix: string;
  inVirtualEnvironment: boolean;
  virtualEnv: string | null;
  condaPrefix: string | null;
  candidateVenvDir: string | null;
  implementation: string;
  platform: string;
  stdlibModuleNames: boolean;
  tomlAvailable: boolean;
}

export interface ScanPayload {
  scannerVersion?: number;
  root: string;
  mode: ScanMode;
  pythonVersion: string;
  tomlAvailable: boolean;
  environment?: EnvironmentSection;
  manifest?: ManifestSection;
  lock?: LockSection;
  lockComparison?: LockComparison;
  imports?: ImportSection;
  error?: string;
}

export interface ScanOutcome {
  ok: boolean;
  interpreter?: string;
  /** Whether the interpreter came from the project environment or from PATH. */
  interpreterOrigin?: 'venv' | 'path';
  payload?: ScanPayload;
  /** Diagnostic code the caller can surface verbatim when `ok` is false. */
  code?:
    'PYTHON_NOT_FOUND' | 'SCANNER_FAILED' | 'SCANNER_INVALID_OUTPUT' | 'SCANNER_VERSION_MISMATCH';
  message?: string;
  stderr?: string;
}

const interpreterPromises = new Map<string, Promise<string | undefined>>();

/**
 * Pick the interpreter used for read-only analysis. `python3` is preferred so a
 * `python` that points at a legacy Python 2 install is never selected.
 *
 * Results are cached per key so repeated tool calls in one session do not probe
 * PATH again.
 */
export async function resolveInterpreter(
  cwd: string,
  signal?: AbortSignal,
  cacheKey = 'path',
): Promise<string | undefined> {
  const cached = interpreterPromises.get(cacheKey);
  if (cached) return cached;
  const pending = (async () => {
    for (const candidate of ['python3', 'python']) {
      const probe = await runCommand(candidate, ['-c', 'import sys; print(sys.version_info[0])'], {
        cwd,
        signal,
        timeoutMs: 5000,
        maxBytes: 2048,
      });
      if (probe.code === 0 && probe.stdout.trim() === '3') return candidate;
    }
    return undefined;
  })();
  interpreterPromises.set(cacheKey, pending);
  return pending;
}

/**
 * Resolve the interpreter whose `site-packages` describe this project.
 *
 * The scanner answers "which distribution provides this import?" by asking the
 * interpreter it runs under. A host `python3` sees only its own site-packages,
 * so every project dependency looks unowned; the project's own interpreter sees
 * the environment that `uv sync` actually built.
 */
export async function resolveProjectInterpreter(
  root: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ interpreter?: string; origin: 'venv' | 'path' }> {
  const venvDir = await findVenvDir(root);
  if (venvDir) {
    const venvInterpreter = await findVenvInterpreter(venvDir);
    if (venvInterpreter) return { interpreter: venvInterpreter, origin: 'venv' };
  }
  return { interpreter: await resolveInterpreter(cwd, signal), origin: 'path' };
}

/**
 * Run the read-only scanner. A missing Python or an older interpreter without
 * `tomllib` degrades to a structured diagnostic instead of throwing, so static
 * tools remain usable in environments without Python tooling installed.
 */
export async function runScanProject(
  cwd: string,
  request: { root: string; mode: ScanMode; maxFiles?: number },
  signal?: AbortSignal,
): Promise<ScanOutcome> {
  const resolved = await resolveProjectInterpreter(request.root, cwd, signal);
  const interpreter = resolved.interpreter;
  const origin = resolved.origin;
  if (!interpreter) {
    return {
      ok: false,
      code: 'PYTHON_NOT_FOUND',
      message: 'No Python 3 interpreter was found in the project environment or on PATH.',
    };
  }
  const helper = HELPER_URL.pathname;
  const run = await runCommand(interpreter, [helper], {
    cwd,
    signal,
    timeoutMs: 30000,
    maxBytes: 2 * 1024 * 1024,
    stdin: JSON.stringify(request),
  });
  if (run.timedOut) {
    return {
      ok: false,
      interpreter,
      interpreterOrigin: origin,
      code: 'SCANNER_FAILED',
      message: 'The project scanner timed out.',
    };
  }
  if (run.code !== 0) {
    return {
      ok: false,
      interpreter,
      interpreterOrigin: origin,
      code: 'SCANNER_FAILED',
      message: 'The project scanner exited with an error.',
      stderr: run.stderr.trim() || undefined,
    };
  }
  try {
    const payload = JSON.parse(run.stdout) as ScanPayload;
    if (payload.error) {
      return {
        ok: false,
        interpreter,
        interpreterOrigin: origin,
        code: 'SCANNER_FAILED',
        message: payload.error,
      };
    }
    // Refuse to interpret a document whose shape may have changed.
    if (
      typeof payload.scannerVersion === 'number' &&
      payload.scannerVersion !== SUPPORTED_SCANNER_VERSION
    ) {
      return {
        ok: false,
        interpreter,
        interpreterOrigin: origin,
        code: 'SCANNER_VERSION_MISMATCH',
        message: `The scanner reported protocol version ${payload.scannerVersion}, but this extension understands version ${SUPPORTED_SCANNER_VERSION}.`,
      };
    }
    return { ok: true, interpreter, interpreterOrigin: origin, payload };
  } catch {
    return {
      ok: false,
      interpreter,
      interpreterOrigin: origin,
      code: 'SCANNER_INVALID_OUTPUT',
      message: 'The project scanner did not return valid JSON.',
      stderr: run.stdout.slice(0, 2000),
    };
  }
}
