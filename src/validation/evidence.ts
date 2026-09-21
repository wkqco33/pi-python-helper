/**
 * Python's view of the shared completion-evidence gate.
 *
 * The gate itself lives in `pi-helper-core`; this module maps the Python
 * wording ("environment sync") onto the core's preparation stage so call sites
 * keep their existing input shape.
 */
import {
  buildCompletionEvidence as coreBuildCompletionEvidence,
  type CompletionEvidence,
} from 'pi-helper-core';

export interface CompletionEvidenceInput {
  syncExecuted: boolean;
  syncOk: boolean;
  testExecuted: boolean;
  testOk: boolean;
  stale: boolean;
  changedPaths: string[];
}

export type { CompletionEvidence };

export function buildCompletionEvidence(input: CompletionEvidenceInput): CompletionEvidence {
  return coreBuildCompletionEvidence({
    preparation: {
      name: 'sync',
      label: 'environment sync (uv sync/lock check)',
      executed: input.syncExecuted,
      ok: input.syncOk,
    },
    testExecuted: input.testExecuted,
    testOk: input.testOk,
    stale: input.stale,
    changedPaths: input.changedPaths,
  });
}
