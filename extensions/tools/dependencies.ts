import { Type } from 'typebox';
import { failure, result } from '../../src/core/result.ts';
import { runCommand } from '../../src/core/runner.ts';
import { planDependencies } from '../../src/dependencies/plan.ts';
import { buildCompletionEvidence } from '../../src/validation/evidence.ts';
import { checkTdd } from '../../src/validation/tdd.ts';
import { messageOf, resolveProjectRoot, text, type Pi } from '../shared.ts';
import { runScanProject } from '../../src/project/scanner.ts';

export function registerDependencyTools(pi: Pi): void {
  pi.registerTool({
    name: 'py_dependency_plan',
    label: 'Python Dependency Plan',
    description:
      'Compare imports found with ast against declared dependencies, dev groups, and uv.lock, and preview the uv commands that would fix the drift. Read-only.',
    promptSnippet: 'Plan Python dependency changes from declared and imported packages',
    promptGuidelines: [
      'Use py_dependency_plan before editing dependencies, and whenever an import fails or a package may be declared in the wrong group.',
      'Use py_dependency_plan to detect drift between pyproject.toml and uv.lock instead of reading the lockfile by hand.',
    ],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Project directory to analyse.' })),
      includeUnused: Type.Optional(
        Type.Boolean({
          description:
            'Also report declared packages that no file imports. Off by default because runtime plugins and console tools produce false positives.',
        }),
      ),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const started = Date.now();
      try {
        const root = await resolveProjectRoot(ctx.cwd, params.path);
        if (!root) {
          return text(
            failure(ctx.cwd, started, 'No Python project root was found.', 'PROJECT_NOT_FOUND'),
          );
        }
        const scan = await runScanProject(ctx.cwd, { root, mode: 'all', maxFiles: 2000 }, signal);
        if (!scan.ok || !scan.payload) {
          return text(
            failure(
              ctx.cwd,
              started,
              scan.message ?? 'The project scanner failed.',
              scan.code ?? 'SCANNER_FAILED',
            ),
          );
        }
        const plan = planDependencies(scan.payload, { includeUnused: params.includeUnused });
        const findings = plan.undeclared.length + plan.misplaced.length;

        return text(
          result(ctx.cwd, started, {
            ok: findings === 0,
            summary:
              `${plan.thirdPartyImportCount} third-party import(s) against ${plan.declaredCount} declared distribution(s); ` +
              `${plan.undeclared.length} undeclared, ${plan.misplaced.length} declared only outside [project] dependencies, ` +
              `${plan.drift.missingFromLock.length + plan.drift.unsatisfiedInLock.length} lockfile drift issue(s).`,
            data: plan,
            evidence: [
              {
                kind: 'dependency_plan',
                undeclared: plan.undeclared.map((entry) => entry.import),
                misplaced: plan.misplaced.map((entry) => ({
                  import: entry.import,
                  distribution: entry.distribution,
                  declaredIn: entry.declaredIn,
                })),
                lockfileDrift: plan.drift,
                providerMappingReliable: plan.providerMappingReliable,
              },
            ],
            warnings: plan.warnings,
            errors: [],
            suggestions: plan.suggestions,
            projectRoot: root,
            pythonVersion: scan.payload.pythonVersion,
          }),
        );
      } catch (error) {
        return text(failure(ctx.cwd, started, messageOf(error), 'INTERNAL_ERROR'));
      }
    },
  });

  pi.registerTool({
    name: 'py_tdd_checkpoint',
    label: 'Python TDD Checkpoint',
    description:
      'Check whether production Python changes have related test changes before implementation is considered complete. Read-only.',
    promptSnippet: 'Check the Python TDD checkpoint for changed files',
    promptGuidelines: [
      'Use py_tdd_checkpoint before reporting Python implementation work as complete.',
    ],
    parameters: Type.Object({
      changedPaths: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
      testChangedPaths: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const started = Date.now();
      let changedPaths = params.changedPaths ?? [];
      let source = 'argument';
      if (!changedPaths.length) {
        const diff = await runCommand('git', ['diff', '--name-only', 'HEAD'], {
          cwd: ctx.cwd,
          signal,
          timeoutMs: 10000,
          maxBytes: 100_000,
        });
        changedPaths = diff.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        source = 'git diff';
      }
      const checkpoint = checkTdd(changedPaths, params.testChangedPaths ?? changedPaths);
      return text(
        result(ctx.cwd, started, {
          ok: checkpoint.ok,
          summary: checkpoint.ok
            ? `TDD checkpoint passed across ${changedPaths.length} changed path(s) from ${source}.`
            : 'TDD checkpoint found production changes without a related test change.',
          data: { ...checkpoint, changedPaths, source },
          evidence: checkpoint.reasons.map((message) => ({ kind: 'tdd_blocker', message })),
          warnings: checkpoint.reasons.map((message) => ({
            code: 'TDD_CHECKPOINT',
            message,
            severity: 'warning' as const,
          })),
          errors: [],
          suggestions: checkpoint.ok
            ? []
            : [
                {
                  message:
                    'Add the smallest focused test for the changed behaviour, or explain why the change needs no test.',
                  confidence: 'high' as const,
                },
              ],
        }),
      );
    },
  });

  pi.registerTool({
    name: 'py_completion_evidence',
    label: 'Python Completion Evidence',
    description:
      'Build a conservative completion report from environment sync and test execution results. Read-only.',
    promptSnippet: 'Create evidence for a Python completion report',
    promptGuidelines: [
      'Use py_completion_evidence before claiming Python work is complete; a partial run is not evidence.',
    ],
    parameters: Type.Object({
      syncExecuted: Type.Boolean({
        description: 'Whether uv lock --check / uv sync actually ran.',
      }),
      syncOk: Type.Boolean(),
      testExecuted: Type.Boolean({ description: 'Whether pytest actually ran.' }),
      testOk: Type.Boolean(),
      stale: Type.Boolean({ description: 'Whether stale artifacts were detected.' }),
      changedPaths: Type.Array(Type.String(), { maxItems: 500 }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const started = Date.now();
      const evidence = buildCompletionEvidence(params);
      return text(
        result(ctx.cwd, started, {
          ok: evidence.ok,
          summary: evidence.ok
            ? 'Completion evidence is sufficient for the supplied checks.'
            : 'Completion evidence is incomplete or contains failing checks.',
          data: evidence,
          evidence: evidence.blockers.map((message) => ({ kind: 'completion_blocker', message })),
          warnings: evidence.blockers.map((message) => ({
            code: 'INCOMPLETE_EVIDENCE',
            message,
            severity: 'warning' as const,
          })),
          errors: evidence.ok
            ? []
            : [
                {
                  code: 'COMPLETION_NOT_PROVEN',
                  message: 'The supplied evidence does not prove completion.',
                  severity: 'error' as const,
                },
              ],
          suggestions: evidence.ok
            ? []
            : [
                {
                  message:
                    'Run py_validation_bundle and address every blocker before reporting completion.',
                  confidence: 'high' as const,
                },
              ],
        }),
      );
    },
  });
}
