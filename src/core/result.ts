import { TOOL_VERSION } from './version.ts';

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface Diagnostic {
  code?: string;
  message: string;
  severity: DiagnosticSeverity;
  path?: string;
  line?: number;
}

export interface Evidence {
  kind: string;
  message?: string;
  [key: string]: unknown;
}

export interface Suggestion {
  message: string;
  confidence?: 'low' | 'medium' | 'high';
  command?: string;
}

export interface CommandPreview {
  executable: string;
  args: string[];
  cwd?: string;
  /** Risk classification for the command; `read` commands never change project state. */
  risk?: 'read' | 'mutating' | 'irreversible';
}

export interface ToolMetadata {
  toolVersion: string;
  cwd: string;
  durationMs: number;
  truncated: boolean;
  projectRoot?: string;
  pythonVersion?: string;
}

/**
 * Every tool in this package returns this shape so the agent can rely on a
 * single contract regardless of which diagnostic ran. Domain fields live in
 * `data`; everything the agent must reason about lives in the typed sections.
 */
export interface PyToolResult<T = unknown> {
  /**
   * The tool's own verdict, not "the tool ran". `true` means the question this
   * tool asks was answered affirmatively: the project state is acceptable, the
   * command succeeded, or the gate may proceed. A diagnostic tool that finds a
   * problem therefore returns `ok: false` without the tool itself having
   * failed. Read `attention` for "must the caller act".
   */
  ok: boolean;
  /**
   * `true` when the caller must act before proceeding: the tool failed, or it
   * emitted a warning or an error. An `info` diagnostic is informational by
   * definition and does not set this. Derived from `ok`, `warnings`, and
   * `errors` unless a tool sets it explicitly, so `ok: false` always implies
   * `attention: true` and no diagnostic is silently dropped. This is the field
   * to read when the question is "do I need to do something".
   */
  attention: boolean;
  summary: string;
  data?: T;
  evidence: Evidence[];
  warnings: Diagnostic[];
  errors: Diagnostic[];
  suggestions: Suggestion[];
  commands?: CommandPreview[];
  metadata: ToolMetadata;
}

/**
 * An `info` diagnostic records a fact; only a warning or an error asks the
 * caller to do something. Keeping them apart stops a purely informational note
 * from raising `attention`.
 */
function isActionable(value: { warnings: Diagnostic[]; errors: Diagnostic[] }): boolean {
  return [...value.warnings, ...value.errors].some((entry) => entry.severity !== 'info');
}

export function result<T>(
  cwd: string,
  startedAt: number,
  value: Omit<PyToolResult<T>, 'metadata' | 'attention'> & {
    attention?: boolean;
    truncated?: boolean;
    projectRoot?: string;
    pythonVersion?: string;
  },
): PyToolResult<T> {
  return {
    ...value,
    attention: value.attention ?? (!value.ok || isActionable(value)),
    metadata: {
      toolVersion: TOOL_VERSION,
      cwd,
      durationMs: Date.now() - startedAt,
      truncated: value.truncated ?? false,
      projectRoot: value.projectRoot,
      pythonVersion: value.pythonVersion,
    },
  };
}

export function failure(
  cwd: string,
  startedAt: number,
  message: string,
  code: string,
  details?: Partial<PyToolResult>,
): PyToolResult {
  return result(cwd, startedAt, {
    ok: false,
    summary: message,
    evidence: [],
    warnings: [],
    errors: [{ code, message, severity: 'error' }],
    suggestions: [],
    ...details,
  });
}

/** Shared helper so diagnostics never lose their code when built inline. */
export function warn(code: string, message: string, path?: string, line?: number): Diagnostic {
  return { code, message, severity: 'warning', path, line };
}
