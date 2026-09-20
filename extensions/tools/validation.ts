import { Type } from 'typebox';
import { failure, result, warn } from '../../src/core/result.ts';
import { runCommand } from '../../src/core/runner.ts';
import { pytestCommand, uvLockCheck, uvSyncFrozen } from '../../src/build/commands.ts';
import { diagnoseFailure } from '../../src/build/failure.ts';
import { parsePytestOutput } from '../../src/build/pytest.ts';
import { detectStaleArtifacts } from '../../src/build/staleness.ts';
import {
  compareInstalledConformance,
  requiredDeclarationsFrom,
} from '../../src/project/conformance.ts';
import { readInstalledDistributions } from '../../src/project/installed.ts';
import { summarizeValidation, type ValidationStep } from '../../src/validation/bundle.ts';
import { buildCompletionEvidence } from '../../src/validation/evidence.ts';
import { checkTdd } from '../../src/validation/tdd.ts';
import { join } from 'node:path';
import { isFile } from '../../src/project/root.ts';
import { runScanProject } from '../../src/project/scanner.ts';
import { messageOf, resolveProjectRoot, text, type Pi } from '../shared.ts';

function stepFrom(run: { code: number | null; timedOut: boolean }): ValidationStep {
  return { executed: true, ok: run.code === 0 && !run.timedOut, exitCode: run.code };
}

export function registerValidationTools(pi: Pi): void {
  pi.registerTool({
    name: 'py_sync',
    label: 'Python Sync',
    description:
      'Preview or run uv lock --check or uv sync --frozen. Execution is opt-in because it modifies .venv. Does not edit sources.',
    promptSnippet: 'Preview or run the uv environment sync',
    promptGuidelines: [
      'Use py_sync with execute=false to preview the uv command, and execute=true only when the environment must be created or refreshed.',
    ],
    parameters: Type.Object({
      mode: Type.Optional(
        Type.Union([Type.Literal('check'), Type.Literal('sync')], {
          description: 'check runs uv lock --check; sync runs uv sync --frozen --all-groups.',
        }),
      ),
      execute: Type.Optional(Type.Boolean()),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800 })),
      path: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const started = Date.now();
      try {
        const root = (await resolveProjectRoot(ctx.cwd, params.path)) ?? ctx.cwd;
        const mode = params.mode ?? 'check';
        const command = mode === 'check' ? uvLockCheck(ctx.cwd) : uvSyncFrozen(ctx.cwd);
        const lockPresent = await isFile(join(root, 'uv.lock'));

        if (!params.execute) {
          return text(
            result(ctx.cwd, started, {
              ok: true,
              summary: `${mode} command preview generated; nothing was executed.`,
              data: { executed: false, mode, command, lockPresent },
              evidence: [{ kind: 'command_preview', ...command }],
              warnings: lockPresent
                ? []
                : [
                    warn(
                      'LOCKFILE_MISSING',
                      'uv.lock does not exist, so uv lock --check cannot confirm the declared dependencies.',
                      root,
                    ),
                  ],
              errors: [],
              suggestions: [
                {
                  message:
                    mode === 'check'
                      ? 'Set execute=true to verify that uv.lock matches pyproject.toml.'
                      : 'Set execute=true to synchronise .venv from the lockfile.',
                  confidence: 'high' as const,
                },
              ],
              commands: [command],
              projectRoot: root,
            }),
          );
        }

        const run = await runCommand(command.executable, command.args, {
          cwd: ctx.cwd,
          signal,
          timeoutMs: (params.timeoutSeconds ?? 600) * 1000,
          maxBytes: 256 * 1024,
        });
        const output = `${run.stdout}\n${run.stderr}`;
        const diagnosis = run.code === 0 ? undefined : diagnoseFailure(output);

        return text(
          result(ctx.cwd, started, {
            ok: run.code === 0,
            summary: run.timedOut
              ? 'uv exceeded the time limit and was terminated.'
              : run.code === 0
                ? mode === 'check'
                  ? 'uv.lock matches pyproject.toml.'
                  : 'The environment was synchronised from the lockfile.'
                : `uv ${mode} failed: ${diagnosis?.summary ?? 'see the captured output.'}`,
            data: {
              executed: true,
              mode,
              exitCode: run.code,
              truncated: run.truncated,
              timedOut: run.timedOut,
              stdoutTail: run.stdout.slice(-4000),
              stderrTail: run.stderr.slice(-4000),
              diagnosis,
            },
            evidence: [{ kind: 'uv_command', mode, exitCode: run.code, executed: true }],
            warnings: run.truncated
              ? [
                  {
                    code: 'OUTPUT_TRUNCATED',
                    message: 'Command output was truncated; only the tail is reported.',
                    severity: 'warning' as const,
                  },
                ]
              : [],
            errors:
              run.code === 0
                ? []
                : [
                    {
                      code: mode === 'check' ? 'LOCKFILE_OUT_OF_DATE' : 'SYNC_FAILED',
                      message:
                        diagnosis?.summary ??
                        run.stderr.trim().slice(0, 500) ??
                        'uv exited with a non-zero status.',
                      severity: 'error' as const,
                    },
                  ],
            suggestions: diagnosis?.suggestions ?? [],
            commands: [command],
            truncated: run.truncated,
            projectRoot: root,
          }),
        );
      } catch (error) {
        return text(failure(ctx.cwd, started, messageOf(error), 'INTERNAL_ERROR'));
      }
    },
  });

  pi.registerTool({
    name: 'py_validation_bundle',
    label: 'Python Validation Bundle',
    description:
      'Preview or run one evidence-oriented sequence: uv lock --check, uv sync --frozen, pytest, and a stale-artifact check. Execution is opt-in.',
    promptSnippet: 'Run the Python sync and test validation bundle',
    promptGuidelines: [
      'Use py_validation_bundle with execute=false first; a preview is never a passing validation.',
      'Use py_validation_bundle as the single completion gate after changing Python sources or dependencies.',
    ],
    parameters: Type.Object({
      targets: Type.Optional(Type.Array(Type.String())),
      execute: Type.Optional(Type.Boolean()),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
      path: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const started = Date.now();
      try {
        const root = (await resolveProjectRoot(ctx.cwd, params.path)) ?? ctx.cwd;
        const lockPresent = await isFile(join(root, 'uv.lock'));
        const lock = uvLockCheck(ctx.cwd);
        const sync = uvSyncFrozen(ctx.cwd);
        const test = pytestCommand(ctx.cwd, { targets: params.targets });
        const timeoutMs = (params.timeoutSeconds ?? 1800) * 1000;
        const commands = [lock, sync, test];

        if (!params.execute) {
          return text(
            result(ctx.cwd, started, {
              ok: true,
              summary: `Validation sequence preview generated (${lockPresent ? 'uv lock --check, uv sync, pytest' : 'uv sync, pytest'}); nothing was executed.`,
              data: { executed: false, lockPresent, steps: commands },
              evidence: [
                {
                  kind: 'validation_preview',
                  steps: commands.map((entry) => entry.args.join(' ')),
                },
              ],
              warnings: lockPresent
                ? []
                : [
                    warn(
                      'LOCKFILE_MISSING',
                      'uv.lock does not exist; the lock check step cannot run and drift will not be detected.',
                      root,
                    ),
                  ],
              errors: [],
              suggestions: [
                {
                  message: 'Set execute=true to run the sequence. This creates or refreshes .venv.',
                  confidence: 'high' as const,
                },
              ],
              commands,
              projectRoot: root,
            }),
          );
        }

        const lockRun = lockPresent
          ? await runCommand(lock.executable, lock.args, {
              cwd: ctx.cwd,
              signal,
              timeoutMs,
              maxBytes: 256 * 1024,
            })
          : undefined;
        const syncRun = await runCommand(sync.executable, sync.args, {
          cwd: ctx.cwd,
          signal,
          timeoutMs,
          maxBytes: 256 * 1024,
        });
        const testRun =
          syncRun.code === 0
            ? await runCommand(test.executable, test.args, {
                cwd: ctx.cwd,
                signal,
                timeoutMs,
                maxBytes: 512 * 1024,
              })
            : undefined;

        const report = testRun ? parsePytestOutput(testRun.stdout, testRun.stderr) : undefined;
        const scan = await runScanProject(ctx.cwd, { root, mode: 'manifest' }, signal);
        const installed = await readInstalledDistributions(join(root, '.venv'));
        const conformance = compareInstalledConformance({
          lock: scan.payload?.lock,
          installed,
          projectName: scan.payload?.manifest?.name ?? undefined,
          requiredDeclarations: requiredDeclarationsFrom(scan.payload?.manifest),
        });
        const staleness = await detectStaleArtifacts(root);

        const lockStep: ValidationStep = lockRun
          ? stepFrom(lockRun)
          : { executed: false, ok: false, exitCode: null };
        const syncStep = stepFrom(syncRun);
        const testStep: ValidationStep = testRun
          ? {
              ...stepFrom(testRun),
              failures: report ? report.counts.failed + report.counts.errors : undefined,
            }
          : { executed: false, ok: false, exitCode: null };

        const summary = summarizeValidation({
          lock: lockStep,
          sync: syncStep,
          test: testStep,
          conformance: conformance.verdict,
          stale: staleness.stale,
        });

        const diagnosis =
          testRun && testStep.ok === false
            ? diagnoseFailure(`${testRun.stdout}\n${testRun.stderr}`)
            : undefined;

        return text(
          result(ctx.cwd, started, {
            ok: summary.ok,
            summary: summary.reason,
            data: {
              executed: true,
              checks: summary.checks,
              lock: { ...lockStep, present: lockPresent },
              sync: syncStep,
              test: {
                ...testStep,
                counts: report?.counts,
                failures: report?.failures.slice(0, 20),
              },
              conformance,
              staleArtifacts: staleness,
              firstFailure: diagnosis,
            },
            evidence: [
              {
                kind: 'validation_bundle',
                checks: summary.checks,
                lockExitCode: lockStep.exitCode ?? null,
                syncExitCode: syncStep.exitCode ?? null,
                testExitCode: testStep.exitCode ?? null,
                testCounts: report?.counts ?? null,
                conformanceVerdict: conformance.verdict,
                stale: staleness.stale,
              },
            ],
            warnings: [
              ...conformance.warnings,
              ...staleness.artifacts.map((artifact) => ({
                code: artifact.code,
                message: artifact.message,
                severity: 'warning' as const,
                path: artifact.path,
              })),
              ...(staleness.incompleteReason
                ? [
                    {
                      code: 'STALENESS_UNVERIFIED',
                      message: `Stale-artifact check was incomplete: ${staleness.incompleteReason}`,
                      severity: 'warning' as const,
                    },
                  ]
                : []),
            ],
            errors: summary.ok
              ? []
              : [
                  {
                    code: 'VALIDATION_FAILED',
                    message: summary.reason,
                    severity: 'error' as const,
                  },
                ],
            suggestions: summary.ok
              ? []
              : [
                  {
                    message:
                      'Fix the failing step before reporting completion; a partial run is not evidence.',
                    confidence: 'high' as const,
                  },
                  ...(diagnosis?.suggestions ?? []),
                ],
            commands,
            projectRoot: root,
            pythonVersion: scan.payload?.pythonVersion,
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
