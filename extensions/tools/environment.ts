import { Type } from 'typebox';
import { join } from 'node:path';
import { result, failure } from '../../src/core/result.ts';
import { detectPythonEnvironment } from '../../src/environment/discovery.ts';
import { inspectProject } from '../../src/project/inspect.ts';
import { readInstalledDistributions } from '../../src/project/installed.ts';
import { detectPytestConfiguration } from '../../src/project/pytest-config.ts';
import { findTestDirectories, isGitIgnored } from '../../src/project/root.ts';
import { runScanProject } from '../../src/project/scanner.ts';
import {
  hasDirectory,
  messageOf,
  readPytestIniFiles,
  resolveProjectRoot,
  text,
  type Pi,
} from '../shared.ts';

export function registerEnvironmentTools(pi: Pi): void {
  pi.registerTool({
    name: 'py_environment',
    label: 'Python Environment',
    description:
      'Inspect the active Python interpreter, virtual environment, uv availability, and project root. Read-only.',
    promptSnippet: 'Inspect the current Python interpreter and uv environment',
    promptGuidelines: [
      'Use py_environment before running Python commands when the active interpreter, virtual environment, or uv availability is unknown.',
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const started = Date.now();
      try {
        const environment = await detectPythonEnvironment(ctx.cwd, signal);
        const python = environment.python;
        const ok = Boolean(environment.interpreter);
        return text(
          result(ctx.cwd, started, {
            ok,
            summary: ok
              ? `Python ${python?.version ?? 'unknown'} (${python?.inVirtualEnvironment ? 'virtual environment' : 'system interpreter'}) · uv ${environment.uv.available ? (environment.uv.version ?? 'available') : 'unavailable'} · ${environment.projectRoot ?? 'no project root'}`
              : 'No Python 3 interpreter is available in this environment.',
            data: environment,
            evidence: [
              {
                kind: 'python_environment',
                interpreter: environment.interpreter,
                version: python?.version,
                executable: python?.executable,
                inVirtualEnvironment: python?.inVirtualEnvironment ?? false,
                virtualEnv: python?.virtualEnv ?? null,
                projectRoot: environment.projectRoot ?? null,
                uv: environment.uv,
              },
            ],
            warnings: environment.warnings,
            errors: ok
              ? []
              : [
                  {
                    code: 'PYTHON_NOT_FOUND',
                    message: 'No Python 3 interpreter was found on PATH.',
                    severity: 'error' as const,
                  },
                ],
            suggestions: environment.suggestions.map((message) => ({
              message,
              confidence: 'medium' as const,
            })),
            projectRoot: environment.projectRoot,
            toolchain: {
              kind: 'python',
              version: python?.version,
              source: environment.projectRoot ? 'project' : 'path',
            },
          }),
        );
      } catch (error) {
        return text(failure(ctx.cwd, started, messageOf(error), 'INTERNAL_ERROR'));
      }
    },
  });

  pi.registerTool({
    name: 'py_project_inspect',
    label: 'Python Project Inspect',
    description:
      'Inspect pyproject.toml, uv.lock, dependency groups, layout, and tool configuration, and report lockfile drift. Read-only.',
    promptSnippet: 'Inspect a Python project manifest and lockfile',
    promptGuidelines: [
      'Use py_project_inspect before editing pyproject.toml or uv.lock, and whenever the project layout or dependency groups are unclear.',
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: 'Project directory, pyproject.toml path, or uv.lock path.' }),
      ),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const started = Date.now();
      try {
        const root = await resolveProjectRoot(ctx.cwd, params.path);
        if (!root) {
          return text(
            failure(
              ctx.cwd,
              started,
              'No Python project root was found. Pass the project directory or a pyproject.toml path.',
              'PROJECT_NOT_FOUND',
            ),
          );
        }
        const scan = await runScanProject(ctx.cwd, { root, mode: 'manifest' }, signal);
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
        const venvPath = join(root, '.venv');
        const venvDir = (await hasDirectory(venvPath)) ? venvPath : undefined;
        const venvIgnored = venvDir ? await isGitIgnored(root, '.venv') : undefined;
        // Tests frequently live inside the package they cover, so the whole tree
        // is searched instead of only `./tests`.
        const testDirectories = await findTestDirectories(root);
        const pytestConfiguration = detectPytestConfiguration({
          pyprojectConfigured: scan.payload.manifest?.toolConfiguration?.pytest === true,
          iniFiles: await readPytestIniFiles(root),
        });
        const installed = venvDir ? await readInstalledDistributions(venvDir) : undefined;
        const inspection = inspectProject({
          payload: scan.payload,
          venvDir,
          venvIgnored,
          hasTestsDirectory: testDirectories.length > 0,
          testDirectories,
          pytestConfiguration,
          installed,
        });

        const conformance = inspection.conformance;
        return text(
          result(ctx.cwd, started, {
            ok: inspection.warnings.length === 0,
            summary:
              `${inspection.pyproject ? `${inspection.name ?? 'unnamed project'}${inspection.version ? ` ${inspection.version}` : ''}` : 'No pyproject.toml'} · ` +
              `${inspection.dependencyCounts.runtime} runtime dependenc(ies) · ` +
              `${inspection.lock.present ? `${inspection.lock.packageCount} locked package(s)` : 'no uv.lock'} · ` +
              `${inspection.layout} layout · ` +
              `conformance: ${conformance ? conformance.verdict : 'not scanned'}`,
            data: inspection,
            evidence: [
              {
                kind: 'project_inspection',
                root: inspection.root,
                pyproject: inspection.pyproject ?? null,
                uvLock: inspection.uvLock ?? null,
                layout: inspection.layout,
                modules: inspection.modules,
                runtimeDependencies: inspection.dependencyCounts.runtime,
                lockedPackages: inspection.lock.packageCount,
                installedPackages: inspection.installed?.count ?? null,
              },
              ...(conformance
                ? [
                    {
                      kind: 'environment_conformance',
                      verdict: conformance.verdict,
                      complete: conformance.complete,
                      counts: conformance.counts,
                      findings: conformance.findings.map((finding) => finding.code),
                    },
                  ]
                : []),
            ],
            warnings: inspection.warnings,
            errors: [],
            suggestions: inspection.suggestions,
            projectRoot: inspection.root,
            toolchain: { kind: 'python', version: scan.payload.pythonVersion, source: 'project' },
          }),
        );
      } catch (error) {
        return text(failure(ctx.cwd, started, messageOf(error), 'INTERNAL_ERROR'));
      }
    },
  });
}
