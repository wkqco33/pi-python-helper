import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import register from '../extensions/index.ts';

interface RegisteredTool {
  name: string;
  description: string;
  promptGuidelines?: string[];
  parameters: { properties?: Record<string, unknown> };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    update: undefined,
    ctx: { cwd: string },
  ) => Promise<{ details?: Record<string, unknown> }>;
}

function loadExtension(): { tools: Map<string, RegisteredTool>; commands: string[] } {
  const tools = new Map<string, RegisteredTool>();
  const commands: string[] = [];
  register({
    registerTool: (tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (name: string) => {
      commands.push(name);
    },
  } as unknown as Parameters<typeof register>[0]);
  return { tools, commands };
}

const EXPECTED_TOOLS = [
  'py_environment',
  'py_project_inspect',
  'py_dependency_plan',
  'py_tdd_checkpoint',
  'py_completion_evidence',
  'py_test_select',
  'py_test',
  'py_failure_diagnose',
  'py_sync',
  'py_validation_bundle',
];

test('the extension registers its tools and command without any Python tooling', () => {
  const { tools, commands } = loadExtension();
  for (const name of EXPECTED_TOOLS) {
    assert.ok(tools.has(name), `expected ${name} to be registered`);
  }
  assert.equal(tools.size, EXPECTED_TOOLS.length, 'no undocumented tools should be registered');
  assert.deepEqual(commands, ['py-status']);
});

test('every tool names itself in its prompt guidelines', () => {
  const { tools } = loadExtension();
  for (const [name, tool] of tools) {
    assert.ok(tool.description.length > 20, `${name} needs a description`);
    for (const guideline of tool.promptGuidelines ?? []) {
      assert.ok(
        guideline.includes(name) || guideline.includes('this tool') === false,
        `${name} guideline must name the tool: ${guideline}`,
      );
    }
  }
});

test('py_completion_evidence reports an incomplete run as not proven', async () => {
  const { tools } = loadExtension();
  const tool = tools.get('py_completion_evidence');
  assert.ok(tool);
  const response = await tool.execute(
    'id',
    {
      syncExecuted: true,
      syncOk: true,
      testExecuted: false,
      testOk: false,
      stale: false,
      changedPaths: ['src/app/parser.py'],
    },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  const details = response.details as { ok: boolean; errors: { code: string }[] };
  assert.equal(details.ok, false);
  assert.equal(details.errors[0].code, 'COMPLETION_NOT_PROVEN');
});

test('py_failure_diagnose points at the project frame, not site-packages', async () => {
  const { tools } = loadExtension();
  const tool = tools.get('py_failure_diagnose');
  assert.ok(tool);
  const output = `Traceback (most recent call last):
  File "/proj/.venv/lib/python3.12/site-packages/pluggy/_callers.py", line 167, in _multicall
    raise exception
  File "/proj/src/app/api.py", line 42, in handler
    return parse(payload)
ModuleNotFoundError: No module named 'pandas'
`;
  const response = await tool.execute('id', { output }, undefined, undefined, {
    cwd: process.cwd(),
  });
  const details = response.details as {
    ok: boolean;
    data: { kind: string; firstUserFrame?: { path: string; line: number } };
  };
  assert.equal(details.data.kind, 'module_not_found');
  assert.equal(details.data.firstUserFrame?.path, '/proj/src/app/api.py');
  assert.equal(details.data.firstUserFrame?.line, 42);
});

test('py_validation_bundle previews without executing', async () => {
  const { tools } = loadExtension();
  const tool = tools.get('py_validation_bundle');
  assert.ok(tool);
  const response = await tool.execute('id', { execute: false }, undefined, undefined, {
    cwd: process.cwd(),
  });
  const details = response.details as {
    data: { executed: boolean };
    commands?: { executable: string; args: string[] }[];
  };
  assert.equal(details.data.executed, false);
  assert.ok(details.commands?.some((entry) => entry.args.join(' ').includes('pytest')));
});

test('py_sync refuses to run a mutating command without execute=true', async () => {
  const { tools } = loadExtension();
  const tool = tools.get('py_sync');
  assert.ok(tool);
  const response = await tool.execute(
    'id',
    { mode: 'sync', execute: false },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  const details = response.details as {
    data: { executed: boolean };
    commands?: { args: string[]; risk?: string }[];
  };
  assert.equal(details.data.executed, false);
  assert.equal(details.commands?.[0].risk, 'mutating');
});

test('py_project_inspect detects an environment that does not match uv.lock', async (t) => {
  const { resolveInterpreter } = await import('../src/project/scanner.ts');
  if (!(await resolveInterpreter(process.cwd()))) {
    t.skip('no Python 3 interpreter available');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'py-conform-'));
  const sitePackages = join(root, '.venv', 'lib', 'python3.12', 'site-packages');
  const writeDistInfo = async (
    directory: string,
    metadata: string,
    directUrl?: string,
  ): Promise<void> => {
    await mkdir(join(sitePackages, directory), { recursive: true });
    await writeFile(join(sitePackages, directory, 'METADATA'), metadata);
    if (directUrl) {
      await writeFile(join(sitePackages, directory, 'direct_url.json'), directUrl);
    }
  };
  try {
    await mkdir(join(root, 'src', 'app'), { recursive: true });
    await writeFile(join(root, '.gitignore'), '.venv/\n');
    await writeFile(
      join(root, 'pyproject.toml'),
      '[project]\nname = "app"\nversion = "0.1.0"\nrequires-python = ">=3.11"\ndependencies = ["requests>=2.31"]\n',
    );
    await writeFile(
      join(root, 'uv.lock'),
      'version = 1\nrevision = 2\nrequires-python = ">=3.11"\n\n[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { editable = "." }\n\n[[package]]\nname = "requests"\nversion = "2.32.3"\nsource = { registry = "https://pypi.org/simple" }\n',
    );
    await writeFile(join(root, 'src', 'app', '__init__.py'), 'import requests\n');
    // The environment is behind the lock and the project is installed as a copy.
    await writeDistInfo('requests-2.31.0.dist-info', 'Name: requests\nVersion: 2.31.0\n');
    await writeDistInfo('app-0.1.0.dist-info', 'Name: app\nVersion: 0.1.0\n');

    const { tools } = loadExtension();
    const inspect = tools.get('py_project_inspect');
    assert.ok(inspect);
    const response = await inspect.execute('id', {}, undefined, undefined, { cwd: root });
    const details = response.details as {
      ok: boolean;
      data: {
        conformance: {
          verdict: string;
          counts: { mismatched: number; missing: number };
          findings: { code: string; name: string }[];
        };
        installed: { count: number; editableCount: number };
      };
      warnings: { code?: string }[];
    };
    assert.equal(details.data.conformance.verdict, 'drifted');
    assert.equal(details.data.conformance.counts.mismatched, 1);
    assert.equal(details.data.installed.count, 2);
    assert.equal(details.data.installed.editableCount, 0);
    assert.deepEqual(details.data.conformance.findings.map((finding) => finding.code).sort(), [
      'INSTALLED_VERSION_MISMATCH',
      'PROJECT_INSTALLED_NOT_EDITABLE',
    ]);
    assert.ok(details.warnings.some((entry) => entry.code === 'INSTALLED_VERSION_MISMATCH'));
    assert.equal(details.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('py_project_inspect reports a consistent environment as consistent', async (t) => {
  const { resolveInterpreter } = await import('../src/project/scanner.ts');
  if (!(await resolveInterpreter(process.cwd()))) {
    t.skip('no Python 3 interpreter available');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'py-conform-ok-'));
  const sitePackages = join(root, '.venv', 'lib', 'python3.12', 'site-packages');
  try {
    await mkdir(join(sitePackages, 'requests-2.32.3.dist-info'), { recursive: true });
    await writeFile(
      join(sitePackages, 'requests-2.32.3.dist-info', 'METADATA'),
      'Name: requests\nVersion: 2.32.3\n',
    );
    await mkdir(join(sitePackages, 'app-0.1.0.dist-info'), { recursive: true });
    await writeFile(
      join(sitePackages, 'app-0.1.0.dist-info', 'METADATA'),
      'Name: app\nVersion: 0.1.0\n',
    );
    await writeFile(
      join(sitePackages, 'app-0.1.0.dist-info', 'direct_url.json'),
      '{"url":"file:///proj","dir_info":{"editable":true}}',
    );
    await mkdir(join(root, 'src', 'app'), { recursive: true });
    await writeFile(join(root, '.gitignore'), '.venv/\n');
    await writeFile(
      join(root, 'pyproject.toml'),
      '[project]\nname = "app"\nversion = "0.1.0"\nrequires-python = ">=3.11"\ndependencies = ["requests>=2.31"]\n',
    );
    await writeFile(
      join(root, 'uv.lock'),
      'version = 1\nrevision = 2\nrequires-python = ">=3.11"\n\n[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { editable = "." }\n\n[[package]]\nname = "requests"\nversion = "2.32.3"\nsource = { registry = "https://pypi.org/simple" }\n',
    );
    await writeFile(join(root, 'src', 'app', '__init__.py'), 'import requests\n');

    const { tools } = loadExtension();
    const inspect = tools.get('py_project_inspect');
    assert.ok(inspect);
    const response = await inspect.execute('id', {}, undefined, undefined, { cwd: root });
    const details = response.details as {
      ok: boolean;
      data: { conformance: { verdict: string; complete: boolean; findings: unknown[] } };
      warnings: { code?: string }[];
    };
    assert.equal(details.data.conformance.verdict, 'consistent');
    assert.equal(details.data.conformance.complete, true);
    assert.deepEqual(details.data.conformance.findings, []);
    assert.deepEqual(details.warnings, []);
    assert.equal(details.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('py_project_inspect does not claim conformance without a virtual environment', async (t) => {
  const { resolveInterpreter } = await import('../src/project/scanner.ts');
  if (!(await resolveInterpreter(process.cwd()))) {
    t.skip('no Python 3 interpreter available');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'py-conform-none-'));
  try {
    await mkdir(join(root, 'src', 'app'), { recursive: true });
    await writeFile(
      join(root, 'pyproject.toml'),
      '[project]\nname = "app"\nversion = "0.1.0"\nrequires-python = ">=3.11"\ndependencies = []\n',
    );
    await writeFile(
      join(root, 'uv.lock'),
      'version = 1\nrevision = 2\nrequires-python = ">=3.11"\n\n[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { editable = "." }\n',
    );
    await writeFile(join(root, 'src', 'app', '__init__.py'), '');

    const { tools } = loadExtension();
    const inspect = tools.get('py_project_inspect');
    assert.ok(inspect);
    const response = await inspect.execute('id', {}, undefined, undefined, { cwd: root });
    const details = response.details as {
      data: { conformance?: unknown; installed?: unknown };
    };
    assert.equal(details.data.conformance, undefined);
    assert.equal(details.data.installed, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('py_project_inspect analyses a real project directory end to end', async (t) => {
  const { resolveInterpreter } = await import('../src/project/scanner.ts');
  if (!(await resolveInterpreter(process.cwd()))) {
    t.skip('no Python 3 interpreter available');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'py-tool-'));
  try {
    await mkdir(join(root, 'src', 'app'), { recursive: true });
    await writeFile(
      join(root, 'pyproject.toml'),
      '[project]\nname = "app"\nversion = "0.2.0"\nrequires-python = ">=3.11"\ndependencies = ["requests>=2.31"]\n',
    );
    await writeFile(
      join(root, 'uv.lock'),
      'version = 1\nrevision = 2\nrequires-python = ">=3.11"\n\n[[package]]\nname = "app"\nversion = "0.2.0"\nsource = { editable = "." }\n\n[[package]]\nname = "requests"\nversion = "2.32.0"\nsource = { registry = "https://pypi.org/simple" }\n',
    );
    await writeFile(join(root, 'src', 'app', '__init__.py'), 'import requests\n');

    const { tools } = loadExtension();
    const inspect = tools.get('py_project_inspect');
    const plan = tools.get('py_dependency_plan');
    assert.ok(inspect && plan);

    const inspection = await inspect.execute('id', {}, undefined, undefined, { cwd: root });
    const inspectionDetails = inspection.details as {
      data: { name: string; layout: string; lock: { packageCount: number } };
      warnings: { code: string }[];
    };
    assert.equal(inspectionDetails.data.name, 'app');
    assert.equal(inspectionDetails.data.layout, 'src');
    assert.equal(inspectionDetails.data.lock.packageCount, 2);
    assert.deepEqual(inspectionDetails.warnings, []);

    const planning = await plan.execute('id', {}, undefined, undefined, { cwd: root });
    const planDetails = planning.details as {
      ok: boolean;
      data: { undeclared: unknown[]; misplaced: unknown[]; drift: { missingFromLock: string[] } };
    };
    assert.equal(planDetails.ok, true);
    assert.deepEqual(planDetails.data.undeclared, []);
    assert.deepEqual(planDetails.data.misplaced, []);
    assert.deepEqual(planDetails.data.drift.missingFromLock, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
