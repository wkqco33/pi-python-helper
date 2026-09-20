export interface CompletionEvidenceInput {
  syncExecuted: boolean;
  syncOk: boolean;
  testExecuted: boolean;
  testOk: boolean;
  stale: boolean;
  changedPaths: string[];
}

export interface CompletionEvidence {
  ok: boolean;
  blockers: string[];
  changedPaths: string[];
}

/**
 * Completion is only proven when the environment was synchronised and the tests
 * actually ran. Declaring completion on a partial run is treated as a blocker,
 * never as a warning.
 */
export function buildCompletionEvidence(input: CompletionEvidenceInput): CompletionEvidence {
  const blockers: string[] = [];
  if (!input.syncExecuted)
    blockers.push('The environment sync (uv sync/lock check) was not executed.');
  else if (!input.syncOk) blockers.push('The environment sync did not pass.');
  if (!input.testExecuted) blockers.push('Tests were not executed.');
  else if (!input.testOk) blockers.push('Tests did not pass.');
  if (input.stale)
    blockers.push(
      'Stale artifacts were detected, so the test result does not describe the current sources.',
    );
  return { ok: blockers.length === 0, blockers, changedPaths: input.changedPaths };
}
