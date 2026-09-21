/**
 * Python's view of the shared validation-bundle gate.
 *
 * `pi-helper-core` owns the lock → preparation → test → quality → conformance
 * sequence; this module names the Python steps (`uv lock --check`, `uv sync`)
 * and preserves the local `sync` field name in the returned `checks` map.
 */
import {
  summarizeValidation as coreSummarizeValidation,
  type ValidationStep,
} from 'pi-helper-core';

export type { ValidationStep };

export interface ValidationSummary {
  ok: boolean;
  reason: string;
  checks: {
    lock: boolean;
    sync: boolean;
    test: boolean;
    conformance: boolean;
    quality: boolean;
    staleArtifacts: boolean;
  };
}

export interface ValidationInput {
  lock: ValidationStep;
  sync: ValidationStep;
  test: ValidationStep;
  /** Declared lint/type commands; omitted when the project declares none. */
  quality?: ValidationStep[];
  conformance: 'consistent' | 'drifted' | 'unverifiable';
  stale: boolean;
  /** True when nothing was executed because the caller only asked for a preview. */
  preview?: boolean;
}

export function summarizeValidation(input: ValidationInput): ValidationSummary {
  const summary = coreSummarizeValidation({
    lock: input.lock,
    preparation: input.sync,
    test: input.test,
    quality: input.quality,
    conformance: input.conformance,
    stale: input.stale,
    preview: input.preview,
    labels: {
      lock: 'uv lock --check',
      preparation: 'uv sync',
      stale: 'a stale coverage report',
    },
  });
  return {
    ok: summary.ok,
    reason: summary.reason,
    checks: {
      lock: summary.checks.lock,
      sync: summary.checks.preparation,
      test: summary.checks.test,
      conformance: summary.checks.conformance,
      quality: summary.checks.quality,
      staleArtifacts: summary.checks.staleArtifacts,
    },
  };
}
