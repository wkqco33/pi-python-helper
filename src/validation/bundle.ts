export interface ValidationStep {
  /** Step label, used for the quality checks (`ruff`, `pyright`). */
  name?: string;
  executed: boolean;
  ok: boolean;
  exitCode?: number | null;
  failures?: number;
  /**
   * Why a step was not executed. A step that was skipped deliberately (the
   * environment is missing the tool it needs) must say so, otherwise the run
   * looks like an unexplained test failure.
   */
  skippedReason?: string;
}

export interface ValidationSummary {
  ok: boolean;
  reason: string;
  checks: {
    lock: boolean;
    sync: boolean;
    test: boolean;
    conformance: boolean;
    /**
     * True when every configured quality command passed. Vacuously true when the
     * project declares none, so a project without lint/type tooling is not
     * penalised.
     */
    quality: boolean;
    staleArtifacts: boolean;
  };
}

const PREVIEW_REASON = 'Set execute=true to run the validation bundle.';

/**
 * The bundle runs `uv lock --check`, then `uv sync --frozen`, then pytest, then
 * verifies that the resulting environment actually matches the lockfile and that
 * no stale coverage report is being quoted.
 *
 * Conformance must be proven, not merely not-failed: a test run that passed
 * against versions the lockfile does not describe is not evidence, so an
 * `unverifiable` verdict fails the gate exactly like drift does.
 *
 * A test step that was never executed is also not evidence, and when the reason
 * is known (the environment no longer provides pytest) that reason is reported
 * instead of a generic failure.
 */
export function summarizeValidation(input: {
  lock: ValidationStep;
  sync: ValidationStep;
  test: ValidationStep;
  /** Declared lint/type commands; omitted when the project declares none. */
  quality?: ValidationStep[];
  conformance: 'consistent' | 'drifted' | 'unverifiable';
  stale: boolean;
  /** True when nothing was executed because the caller only asked for a preview. */
  preview?: boolean;
}): ValidationSummary {
  const lock = input.lock.executed && input.lock.ok;
  const sync = input.sync.executed && input.sync.ok;
  const test = input.test.executed && input.test.ok && (input.test.failures ?? 0) === 0;
  const qualitySteps = input.quality ?? [];
  const quality = qualitySteps.every((step) => step.executed && step.ok);
  const failedQuality = qualitySteps.filter((step) => !step.executed || !step.ok);
  const conformance = input.conformance === 'consistent';
  const staleArtifacts = input.stale;

  let reason = 'Lockfile, environment, tests, and installed versions all agree.';
  if (input.preview) {
    reason = PREVIEW_REASON;
  } else if (!input.lock.executed || !input.sync.executed) {
    reason = !input.lock.executed
      ? 'uv lock --check was not executed, so lockfile agreement is unproven.'
      : 'uv sync was not executed, so the environment the tests ran in is unknown.';
  } else if (!lock) {
    reason = 'uv.lock is out of date; run uv lock before trusting any test result.';
  } else if (!sync) {
    reason = 'The environment could not be synchronised from the lockfile.';
  } else if (!input.test.executed) {
    reason =
      input.test.skippedReason ?? 'Tests were not executed, so no test result exists to report.';
  } else if (!test) {
    reason = 'Tests failed; inspect the first failing case and its project frame.';
  } else if (input.conformance === 'drifted') {
    reason =
      'Tests passed, but the installed versions do not match uv.lock, so the run does not describe the locked environment.';
  } else if (input.conformance === 'unverifiable') {
    reason =
      'The installed environment could not be compared with uv.lock, so the passing test run is not proven to be on the locked versions.';
  } else if (failedQuality.length > 0) {
    const names = failedQuality.map((step) => step.name ?? 'quality check').join(', ');
    reason = `Tests passed, but the declared quality check(s) failed: ${names}.`;
  } else if (staleArtifacts) {
    reason = 'Tests passed, but a stale coverage report was detected; refresh it and rerun.';
  }
  return {
    ok: lock && sync && test && conformance && quality && !staleArtifacts,
    reason,
    checks: { lock, sync, test, conformance, quality, staleArtifacts },
  };
}
