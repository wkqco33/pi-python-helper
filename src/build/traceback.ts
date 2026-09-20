export interface TracebackFrame {
  path: string;
  line: number;
  func: string;
  /** True for site-packages, the standard library, and pytest internals. */
  library: boolean;
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

export function firstUserFrame(frames: TracebackFrame[]): TracebackFrame | undefined {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    if (!frames[index].library) return frames[index];
  }
  return undefined;
}
