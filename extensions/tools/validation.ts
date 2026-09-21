import { Type } from 'typebox';
import { failure, result, warn } from '../../src/core/result.ts';
import { runCommand } from '../../src/core/runner.ts';
import { pytestCommand, uvLockCheck, uvSyncFrozen } from '../../src/build/commands.ts';
import { describeRemovals, parseSyncOutput } from '../../src/build/sync.ts';
import {
  qualityCommands,
  selectQualityRunners,
  type QualityRunner,
} from '../../src/build/quality.ts';
import { diagnoseFailure } from '../../src/build/failure.ts';
import { parsePytestOutput } from '../../src/build/pytest.ts';
import { detectStaleArtifacts } from '../../src/build/staleness.ts';
import {
  compareInstalledConformance,
  requiredDeclarationsFrom,
} from '../../src/project/conformance.ts';
import { readInstalledDistributions } from '../../src/project/installed.ts';
import { buildDeclaredIndex } from '../../src/dependencies/plan.ts';
import { checkRequiredTools } from '../../src/environment/tools.ts';
import { summarizeValidation, type ValidationStep } from '../../src/validation/bundle.ts';
import { buildCompletionEvidence } from '../../src/validation/evidence.ts';
import { checkTdd } from '../../src/validation/tdd.ts';
import { join } from 'node:path';
import { isFile } from '../../src/project/root.ts';
import { runScanProject } from '../../src/project/scanner.ts';
import { hasDirectory, messageOf, resolveProjectRoot, text, type Pi } from '../shared.ts';

function stepFrom(run: { code: number | null; timedOut: boolean }): ValidationStep {
  return { executed: true, ok: run.code === 0 && !run.timedOut, exitCode: run.code };
}

function skippedStep(name: string, reason: string): ValidationStep {
  return { name, executed: false, ok: false, exitCode: null, skippedReason: reason };
}

/** A lock/quality step that the caller disabled rather than one that failed. */
function disabledStep(name: string, reason: string): ValidationStep {
  return { name, executed: false, ok: true, exitCode: null, skippedReason: reason };
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
      'Use py_sync after changing pyproject.toml or uv.lock; a sync that removed packages is reported because later steps cannot run without them.',
    ],
    parameters: Type.Object({
      mode: Type.Optional(
        Type.Union([Type.Literal('check'), Type.Literal('sync')], {
          description:
            'check runs uv lock --check; sync runs uv sync --frozen --all-groups --all-extras.',
        }),
      ),
      extras: Type.Optional(
        Type.Union([Type.Literal('all'), Type.Literal('none')], {
          description:
            'Whether sync requests every [project.optional-dependencies] extra. Defaults to all: without it uv removes extras such as the dev tooling.',
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
        const extras = params.extras ?? 'all';
        const command = mode === 'check' ? uvLockCheck(ctx.cwd) : uvSyncFrozen(ctx.cwd, { extras });
        const lockPresent = await isFile(join(root, 'uv.lock'));

        if (!params.execute) {
          return text(
            result(ctx.cwd, started, {
              ok: true,
              summary: `${mode} command preview generated; nothing was executed.`,
              data: { executed: false, mode, extras, command, lockPresent },
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
        if (mode === 'check') {
          return text(
            result(ctx.cwd, started, {
              ok: run.code === 0,
              summary: run.timedOut
                ? 'uv exceeded the time limit and was terminated.'
                : run.code === 0
                  ? 'uv.lock matches pyproject.toml.'
                  : `uv check failed: ${diagnosis?.summary ?? 'see the captured output.'}`,
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
                        code: 'LOCKFILE_OUT_OF_DATE',
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
        }

        // A sync that removed distributions is the explanation for every later
        // "command not found", so it is reported even on exit code 0.
        const inventory = parseSyncOutput(run.stdout, run.stderr);
        const removals = describeRemovals(inventory);
        const venvPath = join(root, '.venv');
        const venvDir = (await hasDirectory(venvPath)) ? venvPath : undefined;
        const toolchain = await checkRequiredTools(venvDir, ['pytest']);
        const pytestMissing = toolchain.checked && toolchain.missing.includes('pytest');

        return text(
          result(ctx.cwd, started, {
            ok: run.code === 0 && !pytestMissing,
            summary: run.timedOut
              ? 'uv exceeded the time limit and was terminated.'
              : run.code !== 0
                ? `uv sync failed: ${diagnosis?.summary ?? 'see the captured output.'}`
                : pytestMissing
                  ? 'The environment was synchronised, but pytest is not installed in .venv afterwards.'
                  : removals
                    ? `The environment was synchronised from the lockfile. ${removals}`
                    : 'The environment was synchronised from the lockfile.',
            data: {
              executed: true,
              mode,
              extras,
              exitCode: run.code,
              truncated: run.truncated,
              timedOut: run.timedOut,
              inventory,
              removed: inventory.uninstalled,
              toolchain,
              stdoutTail: run.stdout.slice(-4000),
              stderrTail: run.stderr.slice(-4000),
              diagnosis,
            },
            evidence: [
              {
                kind: 'uv_command',
                mode,
                extras,
                exitCode: run.code,
                uninstalled: inventory.uninstalled,
                toolchainMissing: toolchain.missing,
                executed: true,
              },
            ],
            warnings: [
              ...(run.truncated
                ? [
                    {
                      code: 'OUTPUT_TRUNCATED',
                      message: 'Command output was truncated; only the tail is reported.',
                      severity: 'warning' as const,
                    },
                  ]
                : []),
              ...(removals
                ? [
                    warn(
                      'SYNC_REMOVED_PACKAGES',
                      `${removals} Request the extras that provide them (for example uv sync --extra dev) or install everything with uv sync --all-extras.`,
                      join(root, 'uv.lock'),
                    ),
                  ]
                : []),
            ],
            errors:
              run.code === 0 && !pytestMissing
                ? []
                : [
                    {
                      code: pytestMissing ? 'TOOLCHAIN_BROKEN' : 'SYNC_FAILED',
                      message: pytestMissing
                        ? 'pytest is not installed in the project environment after uv sync, so the test step cannot run.'
                        : (diagnosis?.summary ??
                          run.stderr.trim().slice(0, 500) ??
                          'uv exited with a non-zero status.'),
                      severity: 'error' as const,
                    },
                  ],
            suggestions: pytestMissing
              ? [
                  {
                    message:
                      extras === 'all'
                        ? 'pytest is declared in an extra that uv still removed. Check that the extra name is spelled correctly in [project.optional-dependencies].'
                        : 'Re-run the sync with extras=all, or add the extra that provides pytest.',
                    confidence: 'high' as const,
                    command: 'uv sync --frozen --all-groups --all-extras',
                  },
                ]
              : (diagnosis?.suggestions ?? []),
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
      quality: Type.Optional(
        Type.Boolean({
          description:
            'Run the lint/type tools the project declares (ruff, pyright, and mypy when [tool.mypy] exists). Defaults to true.',
        }),
      ),
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
        const runQuality = params.quality ?? true;

        // The declared quality tools are read from the manifest so the bundle can
        // match what CI runs without a separate configuration file.
        const manifestScan = await runScanProject(ctx.cwd, { root, mode: 'manifest' }, signal);
        const runners: QualityRunner[] = runQuality
          ? selectQualityRunners({
              declared: buildDeclaredIndex(
                manifestScan.payload?.manifest ?? {
                  dependencies: [],
                  optionalDependencies: {},
                  dependencyGroups: {},
                },
              ).keys(),
              toolConfiguration: manifestScan.payload?.manifest?.toolConfiguration,
            })
          : [];
        const quality = qualityCommands(ctx.cwd, runners);
        const commands = [lock, sync, test, ...quality];

        if (!params.execute) {
          return text(
            result(ctx.cwd, started, {
              ok: true,
              summary: `Validation sequence preview generated (${[
                lockPresent ? 'uv lock --check' : undefined,
                'uv sync',
                'pytest',
                ...runners.map((runner) => runner.name),
              ]
                .filter(Boolean)
                .join(', ')}); nothing was executed.`,
              data: {
                executed: false,
                lockPresent,
                quality: runners.map((runner) => runner.name),
                steps: commands,
              },
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
                  message:
                    'Set execute=true to run the sequence. This creates or refreshes .venv, including every declared extra.',
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
        const syncInventory = parseSyncOutput(syncRun.stdout, syncRun.stderr);
        const removals = describeRemovals(syncInventory);

        // A sync can succeed while removing the interpreter-side tools the next
        // step needs, so availability is re-checked instead of trusting exit 0.
        const venvPath = join(root, '.venv');
        const venvDir = (await hasDirectory(venvPath)) ? venvPath : undefined;
        const toolchain = await checkRequiredTools(venvDir, [
          'pytest',
          ...runners.map((runner) => runner.name),
        ]);
        const pytestMissing = toolchain.checked && toolchain.missing.includes('pytest');
        const syncOk = syncRun.code === 0 && !pytestMissing;
        const skippedReason = pytestMissing
          ? 'pytest is not installed in the project environment after uv sync, so the test step was skipped and no test result exists.'
          : undefined;

        const testRun = syncOk
          ? await runCommand(test.executable, test.args, {
              cwd: ctx.cwd,
              signal,
              timeoutMs,
              maxBytes: 512 * 1024,
            })
          : undefined;

        const report = testRun ? parsePytestOutput(testRun.stdout, testRun.stderr) : undefined;
        const testPassed = Boolean(report && testRun?.code === 0 && !report.incomplete);

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
          : disabledStep(
              'uv lock --check',
              'uv.lock was not found, so the lock check was skipped.',
            );
        const syncStep: ValidationStep = syncOk
          ? stepFrom(syncRun)
          : {
              ...stepFrom(syncRun),
              ok: false,
              skippedReason,
            };
        const testStep: ValidationStep = testRun
          ? {
              ...stepFrom(testRun),
              failures: report ? report.counts.failed + report.counts.errors : undefined,
            }
          : skippedStep(
              'pytest',
              syncRun.code !== 0
                ? 'The sync step did not complete, so pytest was not run.'
                : (skippedReason ?? 'pytest was not run.'),
            );

        // Quality commands only run once the tests pass: a failing test is the
        // first actionable signal, and running both wastes the caller's budget.
        const qualitySteps: ValidationStep[] = [];
        for (const [index, runner] of runners.entries()) {
          if (!testPassed) {
            qualitySteps.push(
              skippedStep(runner.name, 'Tests did not pass, so the quality check was skipped.'),
            );
            continue;
          }
          if (toolchain.checked && toolchain.missing.includes(runner.name)) {
            qualitySteps.push(
              skippedStep(
                runner.name,
                `${runner.name} is not installed in the project environment, so the quality check was skipped.`,
              ),
            );
            continue;
          }
          const preview = quality[index];
          const run = await runCommand(preview.executable, preview.args, {
            cwd: ctx.cwd,
            signal,
            timeoutMs,
            maxBytes: 256 * 1024,
          });
          qualitySteps.push({ name: runner.name, ...stepFrom(run) });
        }

        const summary = summarizeValidation({
          lock: lockStep,
          sync: syncStep,
          test: testStep,
          quality: qualitySteps,
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
              sync: {
                ...syncStep,
                uninstalled: syncInventory.uninstalled,
                toolchainMissing: toolchain.missing,
              },
              test: {
                ...testStep,
                counts: report?.counts,
                failures: report?.failures.slice(0, 20),
              },
              quality: qualitySteps,
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
                syncUninstalled: syncInventory.uninstalled,
                testExitCode: testStep.exitCode ?? null,
                testCounts: report?.counts ?? null,
                quality: qualitySteps.map((step) => ({ name: step.name, ok: step.ok })),
                conformanceVerdict: conformance.verdict,
                stale: staleness.stale,
              },
            ],
            warnings: [
              ...(removals
                ? [
                    warn(
                      'SYNC_REMOVED_PACKAGES',
                      `${removals} The bundle requests every extra, so a removal here means the tool is not declared as one.`,
                      join(root, 'uv.lock'),
                    ),
                  ]
                : []),
              ...conformance.warnings,
              ...qualitySteps
                .filter((step) => step.executed && !step.ok)
                .map((step) => ({
                  code: 'QUALITY_CHECK_FAILED',
                  message: `${step.name ?? 'quality check'} exited with code ${step.exitCode ?? 'unknown'}.`,
                  severity: 'warning' as const,
                })),
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
                  ...(pytestMissing
                    ? [
                        {
                          message:
                            'pytest is declared in an extra but is not installed after uv sync. Remove the extras=none override, or add the extra that provides pytest to [project.optional-dependencies].',
                          confidence: 'high' as const,
                          command: 'uv sync --frozen --all-groups --all-extras',
                        },
                      ]
                    : []),
                  ...(diagnosis?.suggestions ?? []),
                ],
            commands,
            projectRoot: root,
            toolchain: {
              kind: 'python',
              version: scan.payload?.pythonVersion,
              source: 'project',
            },
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
      const checkpoint = checkTdd(changedPaths, params.testChangedPaths ?? []);
      return text(
        result(ctx.cwd, started, {
          ok: checkpoint.ok,
          summary: checkpoint.ok
            ? `TDD checkpoint passed across ${changedPaths.length} changed path(s) from ${source}.`
            : 'TDD checkpoint found production changes without a related test change.',
          data: { ...checkpoint, changedPaths, source },
          evidence: [
            ...checkpoint.reasons.map((message) => ({ kind: 'tdd_blocker', message })),
            ...checkpoint.associations.map((entry) => ({
              kind: 'tdd_association',
              source: entry.source,
              test: entry.test,
              sharedTokens: entry.sharedTokens,
              strength: entry.strength,
            })),
          ],
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
