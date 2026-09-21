/**
 * Local shim over the shared `pi-helper-core` envelope.
 *
 * Every tool imports `result`/`failure` and the shared types from here, so the
 * envelope is defined in exactly one place (`pi-helper-core`) while call sites
 * stay unaware of that. `pythonVersion` moved into the ecosystem-neutral
 * `metadata.toolchain` field.
 */
import { createResultFactory } from 'pi-helper-core';
import { TOOL_VERSION } from './version.ts';

export const { result, failure } = createResultFactory(TOOL_VERSION);

export { CORE_SCHEMA_VERSION, isActionable, note, warn } from 'pi-helper-core';

export type {
  CommandPreview,
  CommandRisk,
  Diagnostic,
  Evidence,
  Severity,
  Suggestion,
  ToolchainInfo,
  ToolResult,
} from 'pi-helper-core';

/** The Python tools' view of the shared envelope. */
export type PyToolResult<T = unknown> = import('pi-helper-core').ToolResult<T>;
export type DiagnosticSeverity = import('pi-helper-core').Severity;
