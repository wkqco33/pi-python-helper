import { Type } from 'typebox';
import { join } from 'node:path';
import { failure, result, type Diagnostic } from '../../src/core/result.ts';
import {
  auditPytestConfiguration,
  resolvePytestOptions,
  type AsyncTestFile,
} from '../../src/build/pytest-audit.ts';
import { buildDeclaredIndex, normalizeName } from '../../src/dependencies/plan.ts';
import { isRunnableTestFile } from '../../src/project/paths.ts';
import { isDirectory } from '../../src/project/root.ts';
import { runScanProject } from '../../src/project/scanner.ts';
import { messageOf, readPytestIniFiles, resolveProjectRoot, text, type Pi } from '../shared.ts';

export function registerTestConfigTools(pi: Pi): void {
  pi.registerTool({
    name: 'py_test_config',
    label: 'Python Test Config',
    description:
      'Audit pytest configuration against the declared plugins and the tests on disk, and report options that make tests pass without running. Read-only.',
    promptSnippet: 'Validate pytest configuration and detect tests that never run',
    promptGuidelines: [
      'Use py_test_config when a test run reports fewer tests than expected, when async tests may be silently skipped, or before trusting a green run.',
      'Use py_test_config after changing pyproject.toml, pytest.ini, or the test layout to confirm the configuration still matches the project.',
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: 'Project directory to audit; defaults to the project root.' }),
      ),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const started = Date.now();
      try {
        const root = (await resolveProjectRoot(ctx.cwd, params.path)) ?? ctx.cwd;
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

        const manifest = scan.payload.manifest;
        const declared = new Set(
          buildDeclaredIndex(
            manifest ?? {
              dependencies: [],
              optionalDependencies: {},
              dependencyGroups: {},
            },
          ).keys(),
        );

        const resolution = resolvePytestOptions({
          pyprojectOptions: manifest?.pytestOptions ?? null,
          iniFiles: await readPytestIniFiles(root),
        });

        // Only files pytest would actually collect can hide a test, so a script
        // that happens to define `async def test_*` is not reported.
        const testFiles = (scan.payload.imports?.files ?? []).filter((file) =>
          isRunnableTestFile(file.path),
        );
        const unmarkedAsyncTests: AsyncTestFile[] = testFiles
          .map((file) => ({
            path: file.path,
            tests: (file.asyncTests ?? []).filter(
              (name) => !(file.asyncioMarkedTests ?? []).includes(name),
            ),
          }))
          .filter((entry) => entry.tests.length > 0);

        const missingTestPaths: string[] = [];
        for (const entry of resolution.options.testpaths) {
          if (!(await isDirectory(join(root, entry)))) missingTestPaths.push(entry);
        }

        const findings = auditPytestConfiguration({
          sources: resolution.sources,
          options: resolution.options,
          declared,
          unmarkedAsyncTests,
          missingTestPaths,
          hasTestFiles: testFiles.length > 0,
        });

        const toDiagnostic = (finding: (typeof findings)[number]): Diagnostic => ({
          code: finding.code,
          message: finding.suggestion
            ? `${finding.message} ${finding.suggestion}`
            : finding.message,
          severity: finding.severity,
        });
        const errors = findings.filter((finding) => finding.severity === 'error');
        const warnings = findings.filter((finding) => finding.severity !== 'error');

        return text(
          result(ctx.cwd, started, {
            ok: errors.length === 0,
            summary:
              findings.length === 0
                ? `pytest configuration is consistent (${resolution.sources[0] ?? 'no configuration file'}, ${testFiles.length} test file(s)).`
                : `${errors.length} error(s) and ${warnings.length} warning(s) in the pytest configuration.`,
            data: {
              sources: resolution.sources,
              options: resolution.options,
              findings,
              unmarkedAsyncTests,
              missingTestPaths,
              testFileCount: testFiles.length,
              declared: {
                pytestAsyncio: declared.has(normalizeName('pytest-asyncio')),
                pytestCov: declared.has(normalizeName('pytest-cov')),
              },
            },
            evidence: [
              {
                kind: 'pytest_config_audit',
                sources: resolution.sources,
                findings: findings.map((finding) => finding.code),
                unmarkedAsyncTests: unmarkedAsyncTests.reduce(
                  (total, entry) => total + entry.tests.length,
                  0,
                ),
              },
            ],
            warnings: warnings.map(toDiagnostic),
            errors: errors.map(toDiagnostic),
            suggestions: findings
              .filter((finding) => finding.suggestion)
              .map((finding) => ({
                message: finding.suggestion as string,
                confidence: 'high' as const,
              })),
            projectRoot: root,
            pythonVersion: scan.payload.pythonVersion,
          }),
        );
      } catch (error) {
        return text(failure(ctx.cwd, started, messageOf(error), 'INTERNAL_ERROR'));
      }
    },
  });
}
