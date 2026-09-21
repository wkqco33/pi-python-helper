import { Type } from 'typebox';
import { failure, result } from '../../src/core/result.ts';
import { planDependencies } from '../../src/dependencies/plan.ts';
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
            toolchain: { kind: 'python', version: scan.payload.pythonVersion, source: 'project' },
          }),
        );
      } catch (error) {
        return text(failure(ctx.cwd, started, messageOf(error), 'INTERNAL_ERROR'));
      }
    },
  });
}
