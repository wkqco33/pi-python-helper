/**
 * Python has no equivalent of a `cmd_vel` topic that deterministically signals
 * actuation, so risk cannot be inferred from a domain name. Instead every
 * command is classified from its own text, and a compound command inherits the
 * highest risk of its segments.
 */
export type CommandRisk = 'read' | 'mutating' | 'irreversible';

const RISK_ORDER: Record<CommandRisk, number> = { read: 0, mutating: 1, irreversible: 2 };

interface RiskPattern {
  risk: Exclude<CommandRisk, 'read'>;
  pattern: RegExp;
  reason: string;
}

/**
 * Safe overrides are matched before risk patterns so a read-only flag does not
 * inherit the risk of the command it qualifies (`uv lock --check`, `-e .`).
 */
const SAFE_OVERRIDES: RegExp[] = [
  /\buv\s+lock\b[^&|;]*--check\b/,
  /\buv\s+sync\b[^&|;]*--dry-run\b/,
  /\buv\s+(?:tree|export|version|help)\b/,
  /\buv\s+pip\s+(?:list|freeze|check)\b/,
  /\bpytest\b[^&|;]*--collect-only\b/,
  /\bruff\s+(?:check|format)\b[^&|;]*(?:--diff|--check|--no-cache)\b/,
  /\bmypy\b[^&|;]*--no-incremental\b/,
  /\bgit\s+(?:diff|log|status|show|rev-parse|ls-files|branch\s+--show-current)\b/,
];

const RISK_PATTERNS: RiskPattern[] = [
  // Irreversible: cannot be undone by a local revert.
  {
    risk: 'irreversible',
    pattern: /\b(?:uv|poetry|flit|hatch)\s+publish\b|\btwine\s+upload\b/,
    reason: 'Publishing to a package index is public and cannot be retracted.',
  },
  {
    risk: 'irreversible',
    pattern: /\bgit\s+push\b[^&|;]*(?:--force(?:-with-lease)?|-f\b)/,
    reason: 'Force pushing rewrites shared remote history.',
  },
  {
    risk: 'irreversible',
    pattern: /\bgit\s+(?:reset\s+--hard|clean\b[^&|;]*-[a-z]*f)/,
    reason: 'Hard reset or clean discards uncommitted work permanently.',
  },
  {
    risk: 'irreversible',
    pattern: /\b(?:conda|mamba)\s+env\s+remove\b|\bconda\s+remove\b[^&|;]*--all\b/,
    reason: 'Removing an environment destroys installed state.',
  },
  {
    risk: 'irreversible',
    pattern: /\brm\b[^&|;]*-[a-z]*[rf][a-z]*/,
    reason: 'Recursive or forced deletion is not recoverable.',
  },
  {
    risk: 'irreversible',
    pattern:
      /\b(?:drop|truncate)\s+(?:table|database|schema)\b|\bdelete\s+from\b(?![^&|;]*\bwhere\b)/i,
    reason: 'Destructive SQL without a narrowing predicate.',
  },
  {
    risk: 'irreversible',
    pattern: /\b(?:alembic|manage\.py)\b[^&|;]*(?:downgrade|\bzero\b)/,
    reason: 'Reversing a database migration can drop data.',
  },
  {
    risk: 'irreversible',
    pattern: /\bdocker\s+(?:system|volume|image)\s+(?:prune|rm)\b/,
    reason: 'Docker prune removes volumes or images outside the project.',
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
  {
    risk: 'mutating',
    pattern: /\bgit\s+(?:commit|add|checkout|switch|restore|stash|merge|rebase|push|tag)\b/,
    reason: 'Changes repository or remote state.',
  },
  {
    risk: 'mutating',
    pattern: /\b(?:rm|mv|chmod|chown|truncate)\b/,
    reason: 'Changes files on disk.',
  },
];

/** Split a compound command so no segment can hide behind a safe sibling. */
export function splitCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function classifySegment(segment: string): { risk: CommandRisk; reason?: string } {
  if (SAFE_OVERRIDES.some((pattern) => pattern.test(segment))) return { risk: 'read' };
  for (const entry of RISK_PATTERNS) {
    if (entry.pattern.test(segment)) return { risk: entry.risk, reason: entry.reason };
  }
  return { risk: 'read' };
}

export interface CommandClassification {
  risk: CommandRisk;
  reasons: { segment: string; risk: CommandRisk; reason: string }[];
}

/** `curl ... | sh` cannot be seen after segment splitting, so it is matched first. */
const PIPE_TO_SHELL = /\b(?:curl|wget)\b[^;&\n]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/;

/**
 * Classify a shell command by the highest risk of its segments. Used to warn
 * before a tool runs something that cannot be undone, and to gate this
 * package's own environment-modifying commands behind explicit opt-in.
 */
export function classifyCommand(command: string): CommandClassification {
  const piped = command.match(PIPE_TO_SHELL);
  if (piped) {
    return {
      risk: 'irreversible',
      reasons: [
        {
          segment: piped[0].trim(),
          risk: 'irreversible',
          reason: 'Piping a download into a shell runs unreviewed code.',
        },
      ],
    };
  }
  const reasons: CommandClassification['reasons'] = [];
  let risk: CommandRisk = 'read';
  for (const segment of splitCommandSegments(command)) {
    const classified = classifySegment(segment);
    if (RISK_ORDER[classified.risk] > RISK_ORDER[risk]) risk = classified.risk;
    if (classified.risk !== 'read' && classified.reason) {
      reasons.push({ segment, risk: classified.risk, reason: classified.reason });
    }
  }
  return { risk, reasons };
}

export function isMutatingCommand(command: string): boolean {
  return classifyCommand(command).risk !== 'read';
}

/** Commands that this package runs itself always carry a known risk class. */
export function riskOf(args: string[]): CommandRisk {
  return classifyCommand(args.join(' ')).risk;
}
