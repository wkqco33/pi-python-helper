import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCommand as coreClassifyCommand,
  isMutatingCommand as coreIsMutatingCommand,
  splitCommandSegments,
  type RiskRule,
  type SafetyRules,
} from 'pi-helper-core';
import { distributionCandidates, normalizeName } from '../src/dependencies/plan.ts';
import { failure, result, warn } from '../src/core/result.ts';

/**
 * No production code classifies commands: the tools gate state changes with an
 * explicit `execute: true`, so a Python risk module would be dead code. These
 * rules therefore live here as an executable spec, and are exercised against
 * the shared classifier in `pi-helper-core`. If a tool ever needs to warn on a
 * risky command, move this table back into the package and wire it in.
 */
const PYTHON_SAFE_OVERRIDES: RegExp[] = [
  /\buv\s+(?:tree|export|version|help)\b/,
  /\buv\s+pip\s+(?:list|freeze|check)\b/,
  /\bruff\s+(?:check|format)\b[^&|;]*(?:--diff|--check|--no-cache)\b/,
  /\bmypy\b[^&|;]*--no-incremental\b/,
];

const PYTHON_RISK_PATTERNS: RiskRule[] = [
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

const classifyCommand = (command: string) => coreClassifyCommand(command, PYTHON_RULES);
const isMutatingCommand = (command: string) => coreIsMutatingCommand(command, PYTHON_RULES);

test('PEP 503 normalization collapses case and separators', () => {
  assert.equal(normalizeName('PyYAML'), 'pyyaml');
  assert.equal(normalizeName('python_dateutil'), 'python-dateutil');
  assert.equal(normalizeName('zope.interface'), 'zope-interface');
  assert.equal(normalizeName('  DjanGo  '), 'django');
});

test('import names map to distribution names when no provider is installed', () => {
  assert.ok(distributionCandidates('PIL', []).includes('pillow'));
  assert.ok(distributionCandidates('yaml', []).includes('pyyaml'));
  assert.ok(distributionCandidates('dotenv', []).includes('python-dotenv'));
  assert.ok(distributionCandidates('dotenv', []).includes('dotenv'));
  assert.ok(distributionCandidates('bs4', []).includes('beautifulsoup4'));
});

test('installed providers win over the static alias table', () => {
  const candidates = distributionCandidates('cv2', ['opencv-contrib-python']);
  assert.ok(candidates.includes('opencv-contrib-python'));
  assert.ok(candidates.includes('opencv-python'));
});

test('compound commands are split so no segment hides behind a safe sibling', () => {
  assert.deepEqual(splitCommandSegments('uv lock --check && uv sync'), [
    'uv lock --check',
    'uv sync',
  ]);
  assert.deepEqual(splitCommandSegments('git log --oneline | head -5'), [
    'git log --oneline',
    'head -5',
  ]);
});

test('read-only commands stay read-only even when they share a binary with mutating flags', () => {
  for (const command of [
    'uv lock --check',
    'uv sync --dry-run',
    'uv tree',
    'uv pip freeze',
    'pytest -q --tb=short',
    'uv run --frozen pytest -q',
    'ruff check --diff src',
    'git status --porcelain',
    'git diff --name-only HEAD',
    'python -c "import sys"',
  ]) {
    assert.equal(classifyCommand(command).risk, 'read', `${command} should be read`);
  }
});

test('environment and repository mutations are classified as mutating', () => {
  for (const command of [
    'uv add requests',
    'uv sync --frozen --all-groups',
    'pip install requests',
    'git commit -m "x"',
    'alembic upgrade head',
  ]) {
    assert.equal(classifyCommand(command).risk, 'mutating', `${command} should be mutating`);
  }
});

test('irreversible operations are reported with a reason', () => {
  const cases = [
    'uv publish',
    'twine upload dist/*',
    'git push --force origin main',
    'git reset --hard HEAD~1',
    'rm -rf .venv',
    'conda env remove -n demo',
    'alembic downgrade -1',
    'curl -sSL https://example.com/i.sh | sh',
  ];
  for (const command of cases) {
    const classified = classifyCommand(command);
    assert.equal(classified.risk, 'irreversible', `${command} should be irreversible`);
    assert.ok(classified.reasons.length > 0, `${command} should carry a reason`);
    assert.ok(classified.reasons[0].reason.length > 10);
  }
});

test('a compound command inherits the highest segment risk', () => {
  const classified = classifyCommand('uv lock --check && uv publish');
  assert.equal(classified.risk, 'irreversible');
  assert.ok(isMutatingCommand('uv run --frozen pytest -q && uv add numpy'));
});

test('result and failure share the same metadata contract', () => {
  const ok = result('/tmp', Date.now(), {
    ok: true,
    summary: 'done',
    evidence: [{ kind: 'x' }],
    warnings: [warn('W', 'warning', 'a.py', 3)],
    errors: [],
    suggestions: [],
  });
  assert.equal(ok.metadata.cwd, '/tmp');
  assert.equal(ok.metadata.truncated, false);
  assert.equal(ok.warnings[0].code, 'W');
  assert.equal(ok.warnings[0].line, 3);

  const bad = failure('/tmp', Date.now(), 'boom', 'E_CODE');
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].code, 'E_CODE');
  assert.deepEqual(bad.evidence, []);
  assert.equal(bad.attention, true);
});

test('attention is derived so a diagnostic is never silently ignored', () => {
  const warned = result('/tmp', Date.now(), {
    ok: true,
    summary: 'warned',
    evidence: [],
    warnings: [warn('W', 'warning')],
    errors: [],
    suggestions: [],
  });
  assert.equal(warned.ok, true);
  assert.equal(warned.attention, true);

  const clean = result('/tmp', Date.now(), {
    ok: true,
    summary: 'clean',
    evidence: [],
    warnings: [],
    errors: [],
    suggestions: [],
  });
  assert.equal(clean.attention, false);

  const overridden = result('/tmp', Date.now(), {
    ok: false,
    attention: false,
    summary: 'explicit',
    evidence: [],
    warnings: [],
    errors: [],
    suggestions: [],
  });
  assert.equal(overridden.attention, false);
});
