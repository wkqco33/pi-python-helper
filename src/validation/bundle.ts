export interface ValidationStep {
  executed: boolean;
  ok: boolean;
  exitCode?: number | null;
  failures?: number;
}

export interface ValidationSummary {
  ok: boolean;
  reason: string;
  checks: {
    lock: boolean;
    sync: boolean;
    test: boolean;
    conformance: boolean;
    staleArtifacts: boolean;
  };
}

/**
 * The bundle runs `uv lock --check`, then `uv sync --frozen`, then pytest, then
 * verifies that the resulting environment actually matches the lockfile and that
 * no stale coverage report is being quoted.
 *
 * Conformance must be proven, not merely not-failed: a test run that passed
 * against versions the lockfile does not describe is not evidence, so an
 * `unverifiable` verdict fails the gate exactly like drift does.
 */
export function summarizeValidation(input: {
  lock: ValidationStep;
  sync: ValidationStep;
  test: ValidationStep;
  conformance: 'consistent' | 'drifted' | 'unverifiable';
  stale: boolean;
}): ValidationSummary {
  const lock = input.lock.executed && input.lock.ok;
  const sync = input.sync.executed && input.sync.ok;
  const test = input.test.executed && input.test.ok && (input.test.failures ?? 0) === 0;
  const conformance = input.conformance === 'consistent';
  const staleArtifacts = input.stale;

  let reason = 'Lockfile, environment, tests, and installed versions all agree.';
  if (!input.lock.executed || !input.sync.executed || !input.test.executed) {
    reason = 'Set execute=true to run the validation bundle.';
  } else if (!lock) {
    reason = 'uv.lock is out of date; run uv lock before trusting any test result.';
  } else if (!sync) {
    reason = 'The environment could not be synchronised from the lockfile.';
  } else if (!test) {
    reason = 'Tests failed; inspect the first failing case and its project frame.';
  } else if (input.conformance === 'drifted') {
    reason =
      'Tests passed, but the installed versions do not match uv.lock, so the run does not describe the locked environment.';
  } else if (input.conformance === 'unverifiable') {
    reason =
      'The installed environment could not be compared with uv.lock, so the passing test run is not proven to be on the locked versions.';
  } else if (staleArtifacts) {
    reason = 'Tests passed, but a stale coverage report was detected; refresh it and rerun.';
  }
  return {
    ok: lock && sync && test && conformance && !staleArtifacts,
    reason,
    checks: { lock, sync, test, conformance, staleArtifacts },
  };
}
