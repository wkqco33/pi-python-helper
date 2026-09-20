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
  ok: boolean;
  summary: string;
  data?: T;
  evidence: Evidence[];
  warnings: Diagnostic[];
  errors: Diagnostic[];
  suggestions: Suggestion[];
  commands?: CommandPreview[];
  metadata: ToolMetadata;
}

export function result<T>(
  cwd: string,
  startedAt: number,
  value: Omit<PyToolResult<T>, 'metadata'> & {
    truncated?: boolean;
    projectRoot?: string;
    pythonVersion?: string;
  },
): PyToolResult<T> {
  return {
    ...value,
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
