import { Type } from 'typebox';
import { basename } from 'node:path';
import { failure, result } from '../../src/core/result.ts';
import { runCommand } from '../../src/core/runner.ts';
import { pytestCommand } from '../../src/build/commands.ts';
import { changedPaths, listTestFiles } from '../../src/build/discover.ts';
import { diagnoseFailure, refineWithDeclarations } from '../../src/build/failure.ts';
import { parsePytestOutput } from '../../src/build/pytest.ts';
import { selectTests, type TestImportMap } from '../../src/build/selection.ts';
import { buildDeclaredIndex } from '../../src/dependencies/plan.ts';
import { isRunnableTestFile } from '../../src/project/paths.ts';
import { runScanProject } from '../../src/project/scanner.ts';
import { messageOf, resolveProjectRoot, text, type Pi } from '../shared.ts';

/** Cross-check a diagnosis against what the project actually declares. */
async function refine(
  diagnosis: ReturnType<typeof diagnoseFailure>,
  cwd: string,
  root: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ReturnType<typeof diagnoseFailure>> {
  if (!diagnosis.missingModule || !root) return diagnosis;
  const scan = await runScanProject(cwd, { root, mode: 'all', maxFiles: 2000 }, signal);
  if (!scan.ok || !scan.payload) return diagnosis;
  const declared = new Set(
    buildDeclaredIndex(
      scan.payload.manifest ?? {
        dependencies: [],
        optionalDependencies: {},
        dependencyGroups: {},
      },
    ).keys(),
  );
  const localModules = new Set(scan.payload.imports?.localModules ?? []);
  return refineWithDeclarations(diagnosis, { declared, localModules });
}

/**
 * Map each test file to the dotted modules it imports.
 *
 * A test named `test_db_session.py` gives no naming hint that it covers
 * `db/database.py`; the fact that it imports `pkg.db.database` does. The scanner
 * supplies this because only a real parser may be trusted with Python source.
 */
async function collectTestImports(
  root: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<TestImportMap | undefined> {
  const scan = await runScanProject(cwd, { root, mode: 'imports' }, signal);
  const files = scan.payload?.imports?.files;
  if (!scan.ok || !files) return undefined;
  const map: TestImportMap = {};
  for (const entry of files) {
    if (!isRunnableTestFile(entry.path) && basename(entry.path) !== 'conftest.py') continue;
    if (!entry.importModules?.length) continue;
    map[entry.path] = entry.importModules;
  }
  return map;
}

export function registerTestingTools(pi: Pi): void {
  pi.registerTool({
    name: 'py_test_select',
    label: 'Python Test Select',
    description:
      'Select focused pytest targets from changed files using pytest naming conventions, without running tests. Read-only.',
    promptSnippet: 'Select focused Python tests from changed files',
    promptGuidelines: [
      'Use py_test_select after changing Python source to choose a focused pytest target instead of running the whole suite.',
    ],
    parameters: Type.Object({
      changedPaths: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Changed paths; defaults to git diff plus untracked files.',
        }),
      ),
      testFiles: Type.Optional(
        Type.Array(Type.String(), { description: 'Known test files; defaults to a project scan.' }),
      ),
      path: Type.Optional(
        Type.String({ description: 'Project directory to scan for test files.' }),
      ),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const started = Date.now();
      try {
        const root = (await resolveProjectRoot(ctx.cwd, params.path)) ?? ctx.cwd;
        let changed = params.changedPaths ?? [];
        let changedSource = 'argument';
        if (!changed.length) {
          const discovered = await changedPaths(root, signal);
          changed = discovered.paths;
          changedSource = discovered.source === 'git' ? 'git' : (discovered.error ?? 'none');
        }
        const testFiles = params.testFiles ?? (await listTestFiles(root));
        const testImports = params.testFiles
          ? undefined
          : await collectTestImports(root, ctx.cwd, signal);
        const selection = selectTests(changed, testFiles, { testImports });
        // `changed` still holds non-Python paths, so "nothing to select" has to be
        // decided on what the selector actually matched.
        const hasPythonChange =
          selection.changedSourceFiles.length > 0 || selection.changedTestFiles.length > 0;
        // Only files pytest collects tests from become targets; naming
        // `tests/utils.py` as a target overstates the run.
        const targets = selection.selected
          .filter(
            (entry) => isRunnableTestFile(entry.path) || basename(entry.path) === 'conftest.py',
          )
          .map((entry) => entry.path);
        const command = pytestCommand(root, {
          targets: selection.fellBackToAll ? [] : targets,
        });

        return text(
          result(ctx.cwd, started, {
            ok: selection.selected.length > 0 || testFiles.length === 0 || !hasPythonChange,
            summary:
              `${selection.selected.length} test file(s) selected from ${testFiles.length} known test file(s) ` +
              `for ${selection.changedSourceFiles.length} changed source file(s) (${changedSource}).` +
              (selection.fellBackToAll
                ? ' No match was found, so the full suite is in scope.'
                : selection.narrowed
                  ? ''
                  : ' Every candidate matched, so nothing was narrowed.'),
            data: {
              ...selection,
              pytestTargets: targets,
              noNarrowing: !selection.fellBackToAll && !selection.narrowed,
            },
            evidence: [
              {
                kind: 'test_selection',
                changedSourceFiles: selection.changedSourceFiles,
                changedTestFiles: selection.changedTestFiles,
                selected: selection.selected,
                fellBackToAll: selection.fellBackToAll,
                narrowed: selection.narrowed,
                importEvidenceUsed: selection.importEvidenceUsed,
              },
            ],
            warnings: [
              ...(!hasPythonChange
                ? [
                    {
                      code: 'NO_CHANGED_PATHS',
                      message:
                        'No changed Python file was found, so nothing could be selected. Pass changedPaths explicitly when the change is not visible to git.',
                      severity: 'warning' as const,
                    },
                  ]
                : []),
              ...(testFiles.length === 0
                ? [
                    {
                      code: 'NO_TEST_FILES',
                      message:
                        'No pytest test files were found. Create tests/test_<module>.py to enable focused selection.',
                      severity: 'warning' as const,
                    },
                  ]
                : []),
              ...(!selection.fellBackToAll && !selection.narrowed && selection.selected.length > 0
                ? [
                    {
                      code: 'NO_NARROWING',
                      message: `${selection.selected.length} of ${testFiles.length} test file(s) matched, so this selection is the whole suite rather than a focused target.`,
                      severity: 'warning' as const,
                    },
                  ]
                : []),
              ...(selection.fellBackToAll || (!selection.importEvidenceUsed && changed.length > 0)
                ? [
                    {
                      code: 'SELECTION_WITHOUT_IMPORT_EVIDENCE',
                      message:
                        'No candidate was matched by an actual import of a changed module, so this selection rests on file naming alone. Run the full suite or py_test with lastFailed=true when the change is broad.',
                      severity: 'warning' as const,
                    },
                  ]
                : []),
            ],
            errors: [],
            suggestions: selection.selected.length
              ? [
                  {
                    message: `Run the selected targets with py_test, or use py_test with lastFailed=true to rerun only previous failures.`,
                    confidence: 'high' as const,
                  },
                ]
              : [],
            commands: [command],
            projectRoot: root,
          }),
        );
      } catch (error) {
        return text(failure(ctx.cwd, started, messageOf(error), 'INTERNAL_ERROR'));
      }
    },
  });

  pi.registerTool({
    name: 'py_test',
    label: 'Python Test',
    description:
      'Preview or run pytest through uv run --frozen and summarise failures by test, file, and first project frame. Does not modify sources.',
    promptSnippet: 'Preview or run Python tests and summarise failures',
    promptGuidelines: [
      'Use py_test with execute=false first; a preview is never a passing test run.',
      'Use py_test after changing Python sources; it does not rebuild anything, so run py_sync first when dependencies changed.',
      'Use py_test with extraArgs to run project-standard pytest flags such as coverage options that the tool does not model directly.',
    ],
    parameters: Type.Object({
      targets: Type.Optional(Type.Array(Type.String())),
      lastFailed: Type.Optional(
        Type.Boolean({ description: 'Rerun only tests that failed last time (--lf).' }),
      ),
      keyword: Type.Optional(Type.String({ description: 'pytest -k expression.' })),
      extraArgs: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Extra pytest arguments passed verbatim as an argument array, e.g. ["--cov=my_pkg", "--cov-branch"] or ["-m", "unit"].',
        }),
      ),
      maxFail: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
      execute: Type.Optional(Type.Boolean()),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
      path: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const started = Date.now();
      try {
        const root = (await resolveProjectRoot(ctx.cwd, params.path)) ?? ctx.cwd;
        const command = pytestCommand(root, {
          targets: params.targets,
          lastFailed: params.lastFailed,
          keyword: params.keyword,
          extraArgs: params.extraArgs,
          maxFail: params.maxFail,
        });
        if (!params.execute) {
          return text(
            result(ctx.cwd, started, {
              ok: true,
              summary: 'pytest command preview generated; no test was executed.',
              data: { executed: false, command },
              evidence: [{ kind: 'command_preview', ...command }],
              warnings: [],
              errors: [],
              suggestions: [
                {
                  message: 'Set execute=true to run the previewed pytest command.',
                  confidence: 'high' as const,
                },
              ],
              commands: [command],
              projectRoot: root,
            }),
          );
        }

        const run = await runCommand(command.executable, command.args, {
          cwd: root,
          signal,
          timeoutMs: (params.timeoutSeconds ?? 900) * 1000,
          maxBytes: 512 * 1024,
        });
        const report = parsePytestOutput(run.stdout, run.stderr);
        const firstFailure = report.failures[0];
        const diagnosis = firstFailure
          ? await refine(diagnoseFailure(`${run.stdout}\n${run.stderr}`), ctx.cwd, root, signal)
          : undefined;

        const failures = report.failures.slice(0, 20);
        const timedOut = run.timedOut;
        const failedCount = report.counts.failed + report.counts.errors;
        const ok = run.code === 0 && !timedOut && !report.incomplete;
        const errors: { code: string; message: string; severity: 'error' }[] = [];
        if (timedOut) {
          errors.push({
            code: 'TEST_TIMEOUT',
            message: 'pytest was terminated after exceeding the time limit.',
            severity: 'error',
          });
        } else if (failedCount > 0) {
          errors.push({
            code: 'TESTS_FAILED',
            message: `${report.counts.failed} test(s) failed and ${report.counts.errors} error(s) were reported.`,
            severity: 'error',
          });
        } else if (report.incomplete) {
          errors.push({
            code: 'INCOMPLETE_TEST_OUTPUT',
            message: 'pytest produced no summary, so no test result can be trusted.',
            severity: 'error',
          });
        }

        return text(
          result(ctx.cwd, started, {
            ok,
            summary: timedOut
              ? 'pytest exceeded the time limit and was terminated.'
              : report.incomplete
                ? 'pytest did not reach a summary; inspect the captured output before trusting any result.'
                : `${report.counts.passed} passed, ${report.counts.failed} failed, ${report.counts.errors} error(s), ${report.counts.skipped} skipped.`,
            data: {
              executed: true,
              exitCode: run.code,
              truncated: run.truncated,
              timedOut,
              counts: report.counts,
              summaryLine: report.summaryLine,
              noTestsRan: report.noTestsRan,
              failures,
              failureCount: report.failures.length,
              firstFailure: diagnosis,
            },
            evidence: [
              {
                kind: 'pytest_run',
                exitCode: run.code,
                counts: report.counts,
                failures: failures.map((failure) => failure.test),
                executed: true,
              },
            ],
            warnings: [
              ...(report.counts.warnings
                ? [
                    {
                      code: 'PYTEST_WARNINGS',
                      message: `pytest reported ${report.counts.warnings} warning(s); inspect them before changing test code.`,
                      severity: 'warning' as const,
                    },
                  ]
                : []),
              ...(report.incomplete
                ? [
                    {
                      code: 'INCOMPLETE_TEST_OUTPUT',
                      message:
                        'No pytest summary was found in the output; the run may have crashed during collection.',
                      severity: 'warning' as const,
                    },
                  ]
                : []),
            ],
            errors,
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
    name: 'py_failure_diagnose',
    label: 'Python Failure Diagnose',
    description:
      'Classify the first actionable cause in bounded Python, pytest, or uv output and point at the first non-library traceback frame. Read-only.',
    promptSnippet: 'Diagnose the first actionable Python failure',
    promptGuidelines: [
      'Use py_failure_diagnose on bounded command output instead of reading a full traceback in context; traceback frames inside site-packages are never the cause.',
    ],
    parameters: Type.Object({
      output: Type.String({ description: 'Bounded stdout/stderr from the failing command.' }),
      path: Type.Optional(
        Type.String({ description: 'Project directory used to classify the missing module.' }),
      ),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const started = Date.now();
      try {
        const root = await resolveProjectRoot(ctx.cwd, params.path);
        const base = diagnoseFailure(params.output);
        const diagnosis = await refine(base, ctx.cwd, root, signal);
        const libraryFrames = diagnosis.frames.filter((frame) => frame.library).length;

        return text(
          result(ctx.cwd, started, {
            ok: diagnosis.kind !== 'unknown',
            summary: `${diagnosis.kind}: ${diagnosis.summary}`,
            data: {
              ...diagnosis,
              libraryFrameCount: libraryFrames,
              totalFrameCount: diagnosis.frames.length,
            },
            evidence: [
              {
                kind: 'failure_diagnosis',
                failureKind: diagnosis.kind,
                firstUserFrame: diagnosis.firstUserFrame ?? null,
                libraryFrameCount: libraryFrames,
              },
              ...diagnosis.evidence.map((entry) => ({ kind: 'failure_evidence', ...entry })),
            ],
            warnings:
              diagnosis.kind === 'unknown'
                ? [
                    {
                      code: 'UNCLASSIFIED_FAILURE',
                      message:
                        'The output did not match a known Python, pytest, or uv failure pattern.',
                      severity: 'warning' as const,
                    },
                  ]
                : [],
            errors:
              diagnosis.kind === 'unknown'
                ? []
                : [
                    {
                      code: 'FAILURE_DIAGNOSED',
                      message: diagnosis.summary,
                      severity: 'error' as const,
                      path: diagnosis.firstUserFrame?.path,
                      line: diagnosis.firstUserFrame?.line,
                    },
                  ],
            suggestions: diagnosis.suggestions,
            projectRoot: root,
          }),
        );
      } catch (error) {
        return text(failure(ctx.cwd, started, messageOf(error), 'INTERNAL_ERROR'));
      }
    },
  });
}
