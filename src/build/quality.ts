import { uvRun } from './commands.ts';
import type { CommandPreview } from '../core/result.ts';

/**
 * Quality commands a validation bundle can run without any project-specific
 * configuration. Every entry is invoked as an argument array through
 * `uv run --frozen`, so the tool comes from the project environment.
 */
export interface QualityRunner {
  /** Normalized distribution name that must be declared for this to run. */
  distribution: string;
  name: string;
  args: string[];
  /**
   * mypy needs a `[tool.mypy]` table: run bare it reports every untyped
   * third-party call, which is pre-existing noise rather than a regression.
   */
  requiresToolSection?: boolean;
}

export const QUALITY_RUNNERS: QualityRunner[] = [
  { distribution: 'ruff', name: 'ruff', args: ['ruff', 'check', '.'] },
  { distribution: 'pyright', name: 'pyright', args: ['pyright'] },
  { distribution: 'mypy', name: 'mypy', args: ['mypy', '.'], requiresToolSection: true },
];

/**
 * Pick the quality gates the project actually declares.
 *
 * Gating on the *declaration* rather than on a config file matches what CI
 * usually runs: a project can run `ruff check .` with no `[tool.ruff]` table at
 * all, and its absence from the gate would hide a real regression.
 */
export function selectQualityRunners(input: {
  declared: Iterable<string>;
  toolConfiguration?: Record<string, boolean>;
}): QualityRunner[] {
  const declared = new Set(input.declared);
  const configuration = input.toolConfiguration ?? {};
  return QUALITY_RUNNERS.filter((runner) => {
    if (!declared.has(runner.distribution)) return false;
    if (runner.requiresToolSection && configuration[runner.distribution] !== true) return false;
    return true;
  });
}

export function qualityCommands(cwd: string, runners: QualityRunner[]): CommandPreview[] {
  return runners.map((runner) => uvRun(cwd, runner.args));
}
