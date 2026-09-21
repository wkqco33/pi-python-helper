/**
 * Python's risk rules for the shared classifier.
 *
 * Python has no equivalent of a `cmd_vel` topic that deterministically signals
 * actuation, so risk is read from the command text. Segment splitting, safe
 * override precedence, and the compound-command merge live in
 * `pi-helper-core`; this module supplies only the package-manager, environment,
 * and migration rules that are specific to Python. The universal rules (git
 * history, file deletion, destructive SQL, containers, pipe-to-shell) are
 * applied by the core and must not be repeated here.
 */
import {
  classifyCommand as coreClassifyCommand,
  isMutatingCommand as coreIsMutatingCommand,
  riskOf as coreRiskOf,
  type CommandRisk,
  type RiskRule,
  type SafetyRules,
} from 'pi-helper-core';

export { splitCommandSegments } from 'pi-helper-core';
export type { CommandClassification, CommandRisk } from 'pi-helper-core';

/**
 * Safe overrides are matched before risk patterns so a read-only form does not
 * inherit the risk of the command it qualifies. Only the Python-specific
 * read-only forms live here; `--check`, `--dry-run`, and `--collect-only` are
 * already universal overrides in the core.
 */
const PYTHON_SAFE_OVERRIDES: RegExp[] = [
  /\buv\s+(?:tree|export|version|help)\b/,
  /\buv\s+pip\s+(?:list|freeze|check)\b/,
  /\bruff\s+(?:check|format)\b[^&|;]*(?:--diff|--check|--no-cache)\b/,
  /\bmypy\b[^&|;]*--no-incremental\b/,
];

const PYTHON_RISK_PATTERNS: RiskRule[] = [
  // Irreversible: cannot be undone by a local revert.
  {
    risk: 'irreversible',
    pattern: /\b(?:uv|poetry|flit|hatch)\s+publish\b|\btwine\s+upload\b/,
    reason: 'Publishing to a package index is public and cannot be retracted.',
  },
  {
    risk: 'irreversible',
    pattern: /\b(?:conda|mamba)\s+env\s+remove\b|\bconda\s+remove\b[^&|;]*--all\b/,
    reason: 'Removing an environment destroys installed state.',
  },
  {
    risk: 'irreversible',
    pattern: /\b(?:alembic|manage\.py)\b[^&|;]*(?:downgrade|\bzero\b)/,
    reason: 'Reversing a database migration can drop data.',
  },

  // Mutating: changes project, environment, or remote state but is recoverable.
  {
    risk: 'mutating',
    pattern: /\b(?:uv|pdm|poetry)\s+(?:add|remove|sync|lock|update|venv)\b/,
    reason: 'Modifies the environment or the lockfile.',
  },
  {
    risk: 'mutating',
    pattern: /\buv\s+pip\s+(?:install|uninstall|sync)\b/,
    reason: 'Changes installed packages in the active environment.',
  },
  {
    risk: 'mutating',
    pattern: /\b(?:pip|pip3)\s+(?:install|uninstall)\b/,
    reason: 'Changes installed packages in the active environment.',
  },
  {
    risk: 'mutating',
    pattern: /\b(?:conda|mamba)\s+(?:install|create|update|remove)\b/,
    reason: 'Changes conda environment state.',
  },
  {
    risk: 'mutating',
    pattern: /\b(?:alembic|manage\.py)\b[^&|;]*\b(?:upgrade|migrate|makemigrations)\b/,
    reason: 'Applies a schema change to a database.',
  },
  {
    risk: 'mutating',
    pattern: /\bpre-commit\s+(?:install|autoupdate|run|clean)\b/,
    reason: 'Rewrites hook configuration or working tree files.',
  },
];

const PYTHON_RULES: Partial<SafetyRules> = {
  safeOverrides: PYTHON_SAFE_OVERRIDES,
  patterns: PYTHON_RISK_PATTERNS,
};

/**
 * Classify a shell command by the highest risk of its segments. Used to warn
 * before a tool runs something that cannot be undone, and to gate this
 * package's own environment-modifying commands behind explicit opt-in.
 */
export function classifyCommand(command: string): import('pi-helper-core').CommandClassification {
  return coreClassifyCommand(command, PYTHON_RULES);
}

export function isMutatingCommand(command: string): boolean {
  return coreIsMutatingCommand(command, PYTHON_RULES);
}

/** Commands that this package runs itself always carry a known risk class. */
export function riskOf(args: string[]): CommandRisk {
  return coreRiskOf(args, PYTHON_RULES);
}
