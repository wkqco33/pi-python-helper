/**
 * uv prints a per-package inventory when `uv sync` changes the environment:
 *
 * ```text
 * Uninstalled 10 packages in 305ms
 *  - coverage==7.15.4
 *  - pytest==9.0.3
 *  + ruff==0.15.5
 * ```
 *
 * Removals matter because a sync that silently drops the project's own dev
 * tooling leaves every later step unable to run, so the inventory is parsed
 * rather than discarded.
 */
export interface SyncInventory {
  installed: string[];
  uninstalled: string[];
  /** One of `uv`'s summary lines, e.g. `Audited 78 packages in 3ms`. */
  summaryLines: string[];
}

const COUNT_LINE = /^(Installed|Uninstalled|Prepared|Audited|Resolved)\b/;
const PACKAGE_LINE = /^\s*([+-])\s*([A-Za-z0-9._-]+)(?:==(\S+))?\s*$/;

function stripVersion(name: string): string {
  return name.trim();
}

/**
 * Read the installed/uninstalled inventory out of uv's stdout. Anything that
 * does not match the documented layout is ignored rather than guessed at, so a
 * future uv output change degrades to "no inventory" instead of a wrong one.
 */
export function parseSyncOutput(stdout: string, stderr = ''): SyncInventory {
  const installed: string[] = [];
  const uninstalled: string[] = [];
  const summaryLines: string[] = [];
  let section: 'installed' | 'uninstalled' | null = null;

  for (const rawLine of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (COUNT_LINE.test(line.trim())) {
      summaryLines.push(line.trim());
      if (/^Uninstalled\b/.test(line.trim())) section = 'uninstalled';
      else if (/^Installed\b/.test(line.trim())) section = 'installed';
      else section = null;
      continue;
    }
    const match = line.match(PACKAGE_LINE);
    if (!match || !section) continue;
    const name = stripVersion(match[2]);
    if (match[1] === '-' && section === 'uninstalled') uninstalled.push(name);
    else if (match[1] === '+' && section === 'installed') installed.push(name);
  }

  return { installed, uninstalled, summaryLines };
}

/**
 * A sync that removes distributions is worth reporting even when it exits zero:
 * on its own it is not a failure, but it explains every later "command not
 * found" failure in the same run.
 */
export function describeRemovals(inventory: SyncInventory): string | undefined {
  if (inventory.uninstalled.length === 0) return undefined;
  const shown = inventory.uninstalled.slice(0, 12).join(', ');
  const rest =
    inventory.uninstalled.length > 12 ? `, … (+${inventory.uninstalled.length - 12})` : '';
  return `uv sync removed ${inventory.uninstalled.length} distribution(s) from .venv: ${shown}${rest}.`;
}
