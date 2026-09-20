import type { Suggestion } from '../core/result.ts';

export type FailureKind =
  | 'module_not_found'
  | 'environment_not_synced'
  | 'import_error'
  | 'syntax_error'
  | 'collection_error'
  | 'fixture_error'
  | 'assertion'
  | 'runtime_error'
  | 'lockfile_out_of_date'
  | 'resolution_error'
  | 'dependency_conflict'
  | 'timeout'
  | 'unknown';

export interface TracebackFrame {
  path: string;
  line: number;
  func: string;
  /** True for site-packages, the standard library, and pytest internals. */
  library: boolean;
}

export interface FailureEvidence {
  file?: string;
  line?: number;
  message: string;
}

export interface FailureDiagnosis {
  kind: FailureKind;
  summary: string;
  missingModule?: string;
  importTarget?: { name: string; module: string };
  exceptionType?: string;
  frames: TracebackFrame[];
  /** Last frame outside site-packages: the line the user should look at. */
  firstUserFrame?: TracebackFrame;
  evidence: FailureEvidence[];
  suggestions: Suggestion[];
}

const FRAME_RE = /^\s*File "([^"]+)", line (\d+), in (.+?)\s*$/;
/**
 * pytest `--tb=short` replaces the `File "..."` form with `path:line: in func`,
 * so both notations must be recognised or short tracebacks yield no frame at all.
 */
const PYTEST_FRAME_RE = /^\s*([^\s:]+\.py):(\d+): in (.+?)\s*$/;

/**
 * A frame belongs to library code when it sits in an installed distribution or
 * in the interpreter's own library tree. Pointing the agent at those frames is
 * how it ends up editing site-packages instead of the project.
 */
export function isLibraryFrame(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return (
    /\/site-packages\//.test(normalized) ||
    /\/dist-packages\//.test(normalized) ||
    /\/lib\/python3\.\d+\//.test(normalized) ||
    /\/python3\.\d+\//.test(normalized) ||
    /<frozen /.test(normalized) ||
    /\/_pytest\//.test(normalized) ||
    /\/pluggy\//.test(normalized)
  );
}

export function extractTracebackFrames(output: string): TracebackFrame[] {
  const frames: TracebackFrame[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(FRAME_RE) ?? line.match(PYTEST_FRAME_RE);
    if (!match) continue;
    const path = match[1];
    frames.push({
      path,
      line: Number.parseInt(match[2], 10),
      func: match[3].trim(),
      library: isLibraryFrame(path),
    });
  }
  return frames;
}

function firstUserFrame(frames: TracebackFrame[]): TracebackFrame | undefined {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    if (!frames[index].library) return frames[index];
  }
  return undefined;
}

function lastMatch(output: string, pattern: RegExp): RegExpMatchArray | undefined {
  const matches = [...output.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
  return matches.at(-1);
}

/**
 * Classify the first actionable cause in bounded command output. The order of
 * the checks matters: a resolution failure means nothing downstream is
 * trustworthy, and a missing module explains the traceback that follows it.
 */
export function diagnoseFailure(output: string): FailureDiagnosis {
  const frames = extractTracebackFrames(output);
  const userFrame = firstUserFrame(frames);

  const lockProblem = lastMatch(
    output,
    /(?:lockfile at .*needs to be updated|--locked was provided|lockfile .* is not up to date|`uv lock`)/i,
  );
  if (lockProblem) {
    return {
      kind: 'lockfile_out_of_date',
      summary:
        'uv refused to continue because uv.lock no longer matches pyproject.toml (--locked/--frozen was used).',
      exceptionType: 'uv',
      frames,
      firstUserFrame: userFrame,
      evidence: [{ message: lockProblem[0].trim() }],
      suggestions: [
        {
          message: 'Run uv lock and commit the refreshed uv.lock before rerunning the command.',
          confidence: 'high',
          command: 'uv lock',
        },
      ],
    };
  }

  const conflict = lastMatch(
    output,
    /(?:Because .+ depends on .+|No solution found when resolving dependencies|version solving failed)/,
  );
  if (conflict) {
    return {
      kind: 'dependency_conflict',
      summary: 'uv could not find a version set that satisfies every declared constraint.',
      exceptionType: 'uv',
      frames,
      firstUserFrame: userFrame,
      evidence: [{ message: conflict[0].trim() }],
      suggestions: [
        {
          message:
            'Inspect the reported conflict chain and relax or pin the offending requirement.',
          confidence: 'high',
          command: 'uv lock --verbose',
        },
      ],
    };
  }

  const resolveFailure = lastMatch(
    output,
    /(?:Failed to resolve requirements|error: Failed to download|Could not find a version that satisfies)/,
  );
  if (resolveFailure) {
    return {
      kind: 'resolution_error',
      summary: 'uv could not resolve or download a declared requirement.',
      exceptionType: 'uv',
      frames,
      firstUserFrame: userFrame,
      evidence: [{ message: resolveFailure[0].trim() }],
      suggestions: [
        {
          message:
            'Check the package name and version constraint, then retry with uv lock --verbose.',
          confidence: 'medium',
        },
      ],
    };
  }

  const missing = lastMatch(output, /ModuleNotFoundError: No module named '([^']+)'/);
  const cannotImport = lastMatch(
    output,
    /ImportError: cannot import name '([^']+)' from '([^']+)'/,
  );
  const syntax = lastMatch(output, /SyntaxError: (.+)/);
  const fixture = lastMatch(
    output,
    /(?:fixture '[^']+' not found|ERROR at setup of|error in .* fixture)/,
  );
  const collection = lastMatch(
    output,
    /(?:errors during collection|Interrupted: \d+ error|ERROR collecting)/,
  );
  const assertion = lastMatch(output, /^\s*E\s+(AssertionError.*|assert .*)$/m);
  // pytest prefixes the exception line with `E ` inside a report, so the marker
  // must be optional here or a plain NameError/ValueError looks unclassified.
  const genericError = lastMatch(output, /^(?:\s*E\s+)?(?:[A-Za-z_.]*(?:Error|Exception)): (.+)$/m);

  // Pick the cause that appears first in the output. "First actionable" must be
  // positional: a fixture error printed after a failing assertion is not the
  // root cause the user needs to read first.
  const candidates: { kind: FailureKind; index: number }[] = [];
  const consider = (kind: FailureKind, pattern: RegExp) => {
    const match = output.match(pattern);
    if (match?.index !== undefined) candidates.push({ kind, index: match.index });
  };
  consider('module_not_found', /ModuleNotFoundError: No module named '([^']+)'/);
  consider('import_error', /ImportError: cannot import name '([^']+)' from '([^']+)'/);
  consider('syntax_error', /SyntaxError: (.+)/);
  consider('fixture_error', /(?:fixture '[^']+' not found|ERROR at setup of|error in .* fixture)/);
  consider(
    'collection_error',
    /(?:errors during collection|Interrupted: \d+ error|ERROR collecting)/,
  );
  consider('assertion', /^\s*E\s+(AssertionError.*|assert .*)$/m);
  consider('runtime_error', /^(?:\s*E\s+)?(?:[A-Za-z_.]*(?:Error|Exception)): (.+)$/m);
  candidates.sort((left, right) => left.index - right.index);
  const kind: FailureKind = candidates[0]?.kind ?? 'unknown';

  if (kind === 'module_not_found' && missing) {
    const module = missing[1].split('.')[0];
    return {
      kind: 'module_not_found',
      summary: `Import failed because the module "${module}" could not be found.`,
      missingModule: module,
      exceptionType: 'ModuleNotFoundError',
      frames,
      firstUserFrame: userFrame,
      evidence: [{ message: missing[0].trim(), file: userFrame?.path, line: userFrame?.line }],
      suggestions: [
        {
          message: `Declare the distribution that provides "${module}" with uv add ${module} if it is third-party. Import names often differ from distribution names (PIL/pillow, yaml/PyYAML).`,
          confidence: 'medium',
          command: `uv add ${module}`,
        },
        {
          message:
            'If the module is project code, run uv sync so the project package is installed in editable mode.',
          confidence: 'medium',
          command: 'uv sync',
        },
      ],
    };
  }

  const cannotImportBranch = kind === 'import_error' ? cannotImport : undefined;
  if (cannotImportBranch) {
    return {
      kind: 'import_error',
      summary: `The name "${cannotImportBranch[1]}" does not exist in module "${cannotImportBranch[2]}".`,
      importTarget: { name: cannotImportBranch[1], module: cannotImportBranch[2] },
      exceptionType: 'ImportError',
      frames,
      firstUserFrame: userFrame,
      evidence: [
        { message: cannotImportBranch[0].trim(), file: userFrame?.path, line: userFrame?.line },
      ],
      suggestions: [
        {
          message: `Verify the symbol name in "${cannotImportBranch[2]}" and whether the installed version exposes it.`,
          confidence: 'medium',
        },
      ],
    };
  }

  if (kind === 'syntax_error' && syntax) {
    const location = lastMatch(output, /File "([^"]+)", line (\d+)/);
    return {
      kind: 'syntax_error',
      summary: `A file could not be parsed: ${syntax[1].trim()}`,
      exceptionType: 'SyntaxError',
      frames,
      firstUserFrame: userFrame,
      evidence: [
        {
          message: syntax[0].trim(),
          file: location?.[1],
          line: location ? Number.parseInt(location[2], 10) : undefined,
        },
      ],
      suggestions: [
        {
          message: 'Fix the syntax error at the reported file and line before rerunning.',
          confidence: 'high',
        },
      ],
    };
  }

  if (kind === 'fixture_error' && fixture) {
    return {
      kind: 'fixture_error',
      summary: 'A pytest fixture could not be resolved for a test.',
      exceptionType: 'fixture',
      frames,
      firstUserFrame: userFrame,
      evidence: [{ message: fixture[0].trim(), file: userFrame?.path, line: userFrame?.line }],
      suggestions: [
        {
          message: 'Define the fixture in a conftest.py that is in scope for the failing test.',
          confidence: 'medium',
        },
      ],
    };
  }

  if (kind === 'collection_error' && collection) {
    return {
      kind: 'collection_error',
      summary: 'pytest could not collect the test suite, so no test result is trustworthy.',
      exceptionType: 'pytest',
      frames,
      firstUserFrame: userFrame,
      evidence: [{ message: collection[0].trim(), file: userFrame?.path, line: userFrame?.line }],
      suggestions: [
        {
          message:
            'Resolve the import or syntax error reported for the collected file, then rerun.',
          confidence: 'high',
        },
      ],
    };
  }

  if (kind === 'assertion' && assertion) {
    return {
      kind: 'assertion',
      summary: 'A test assertion failed; the expectation does not match the observed behaviour.',
      exceptionType: 'AssertionError',
      frames,
      firstUserFrame: userFrame,
      evidence: [
        {
          message: assertion[1].trim().slice(0, 500),
          file: userFrame?.path,
          line: userFrame?.line,
        },
      ],
      suggestions: [
        {
          message:
            'Inspect the failing expectation and the production code that produced the value.',
          confidence: 'medium',
        },
      ],
    };
  }

  if (kind === 'runtime_error' && genericError) {
    const exceptionType = genericError[0].trim().split(':')[0].trim().replace(/^E\s+/, '');
    return {
      kind: 'runtime_error',
      summary: genericError[0].trim().slice(0, 300),
      exceptionType,
      frames,
      firstUserFrame: userFrame,
      evidence: [
        {
          message: genericError[0].trim().slice(0, 500),
          file: userFrame?.path,
          line: userFrame?.line,
        },
      ],
      suggestions: [
        {
          message: userFrame
            ? `Start from ${userFrame.path}:${userFrame.line}; frames inside site-packages are not the cause.`
            : 'The failure has no project frame; check whether the command ran in the intended environment.',
          confidence: 'low',
        },
      ],
    };
  }

  return {
    kind: 'unknown',
    summary:
      'No recognised Python, pytest, or uv failure pattern was found in the captured output.',
    frames,
    firstUserFrame: userFrame,
    evidence: [],
    suggestions: [
      {
        message:
          'Rerun the command with more verbose output so the first actionable cause is captured.',
        confidence: 'low',
      },
    ],
  };
}

/**
 * Improve a diagnosis using the project model. A module that is declared but
 * still unimportable is an environment problem, not a missing declaration.
 */
export function refineWithDeclarations(
  diagnosis: FailureDiagnosis,
  input: { declared: Set<string>; localModules: Set<string> },
): FailureDiagnosis {
  const module = diagnosis.missingModule;
  if (!module) return diagnosis;
  const normalized = module.replace(/[-_.]+/g, '-').toLowerCase();
  const suggestions: Suggestion[] = [];

  if (input.localModules.has(module)) {
    return {
      ...diagnosis,
      kind: 'environment_not_synced',
      summary: `"${module}" is project code but is not importable from the active interpreter.`,
      suggestions: [
        {
          message:
            'The package is not installed into the environment. Run uv sync so the project is installed in editable mode.',
          confidence: 'high',
          command: 'uv sync',
        },
        {
          message: 'Confirm the import path matches the src layout (src/<package>/...).',
          confidence: 'medium',
        },
      ],
    };
  }

  if (input.declared.has(normalized)) {
    return {
      ...diagnosis,
      kind: 'environment_not_synced',
      summary: `"${module}" is declared in pyproject.toml but is missing from the active environment.`,
      suggestions: [
        {
          message: 'The environment is out of sync with the lockfile. Run uv sync --frozen.',
          confidence: 'high',
          command: 'uv sync --frozen',
        },
        {
          message:
            'If the command ran outside the project environment, re-run it through uv run so the correct interpreter is used.',
          confidence: 'high',
          command: 'uv run --frozen pytest',
        },
      ],
    };
  }

  suggestions.push({
    message: `Declare the distribution providing "${module}" with uv add ${module}, or verify the import name.`,
    confidence: 'medium',
    command: `uv add ${module}`,
  });
  suggestions.push({
    message: 'Import names can differ from distribution names (PIL/pillow, yaml/PyYAML).',
    confidence: 'medium',
  });
  return { ...diagnosis, suggestions: [...diagnosis.suggestions, ...suggestions] };
}
