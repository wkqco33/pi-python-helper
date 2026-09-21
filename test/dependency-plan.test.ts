import test from 'node:test';
import assert from 'node:assert/strict';
import { planDependencies, buildDeclaredIndex } from '../src/dependencies/plan.ts';
import { inspectProject } from '../src/project/inspect.ts';
import type { DeclaredDependency, ManifestSection, ScanPayload } from '../src/project/scanner.ts';

function dependency(raw: string): DeclaredDependency {
  const match = raw.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
  const name = match ? match[1] : raw;
  return {
    raw,
    name,
    normalized: name.replace(/[-_.]+/g, '-').toLowerCase(),
    specifier: raw.slice(name.length).trim(),
    extras: [],
    marker: null,
  };
}

function manifest(overrides: Partial<ManifestSection> = {}): ManifestSection {
  return {
    pyprojectPath: '/proj/pyproject.toml',
    name: 'demo-pkg',
    version: '0.1.0',
    requiresPython: '>=3.11',
    description: null,
    license: null,
    importName: 'demo_pkg',
    dependencies: [],
    optionalDependencies: {},
    dependencyGroups: {},
    buildBackend: 'hatchling.build',
    buildRequires: [],
    entryPoints: [],
    toolConfiguration: {},
    layout: 'src',
    modules: ['demo_pkg'],
    legacySetupPy: false,
    legacySetupCfg: false,
    requirementsFiles: [],
    uvWorkspaceMembers: [],
    uvSources: [],
    warnings: [],
    ...overrides,
  };
}

function payload(
  input: {
    manifest?: ManifestSection;
    thirdParty?: {
      import: string;
      files: string[];
      providers: string[];
      typeCheckingOnly?: boolean;
      typeCheckingFiles?: string[];
    }[];
    lock?: Partial<NonNullable<ScanPayload['lock']>>;
    comparison?: Partial<NonNullable<ScanPayload['lockComparison']>>;
  } = {},
): ScanPayload {
  const thirdParty = input.thirdParty ?? [];
  return {
    root: '/proj',
    mode: 'all',
    pythonVersion: '3.12.0',
    tomlAvailable: true,
    manifest: input.manifest ?? manifest(),
    lock: {
      path: '/proj/uv.lock',
      present: true,
      version: 1,
      revision: 2,
      requiresPython: null,
      packages: [],
      warnings: [],
      ...input.lock,
    },
    lockComparison: {
      specifierCheckAvailable: true,
      missingFromLock: [],
      unsatisfiedInLock: [],
      requiresPythonMismatch: null,
      checkedCount: 0,
      ...input.comparison,
    },
    imports: {
      pythonVersion: '3.12.0',
      stdlibAvailable: true,
      layout: 'src',
      localModules: ['demo_pkg'],
      files: [],
      thirdParty: thirdParty.map((entry) => ({
        import: entry.import,
        files: entry.files,
        fileCount: entry.files.length,
        providers: entry.providers,
        typeCheckingOnly: entry.typeCheckingOnly ?? false,
        typeCheckingFiles: entry.typeCheckingFiles ?? [],
      })),
      providersUnavailable: false,
      unparsable: [],
      scannedFiles: thirdParty.length,
      truncated: false,
    },
  };
}

test('declared index merges groups and normalises names', () => {
  const index = buildDeclaredIndex({
    dependencies: [dependency('requests>=2.31'), dependency('Pillow')],
    optionalDependencies: { aws: [dependency('boto3')] },
    dependencyGroups: { dev: [dependency('pytest>=8')] },
  });
  assert.deepEqual(index.get('pillow')?.groups, ['runtime']);
  assert.deepEqual(index.get('boto3')?.groups, ['optional:aws']);
  assert.deepEqual(index.get('pytest')?.groups, ['group:dev']);
});

test('an import with no declaration is reported with a uv add suggestion', () => {
  const plan = planDependencies(
    payload({
      thirdParty: [{ import: 'numpy', files: ['src/demo_pkg/main.py'], providers: [] }],
    }),
  );
  assert.equal(plan.undeclared.length, 1);
  assert.equal(plan.warnings[0].code, 'UNDECLARED_IMPORT');
  assert.equal(plan.suggestions[0].command, 'uv add numpy');
});

test('an alias-resolved import is not reported as undeclared', () => {
  const plan = planDependencies(
    payload({
      manifest: manifest({ dependencies: [dependency('pillow>=10')] }),
      thirdParty: [{ import: 'PIL', files: ['src/demo_pkg/img.py'], providers: ['pillow'] }],
    }),
  );
  assert.deepEqual(plan.undeclared, []);
  assert.deepEqual(plan.misplaced, []);
});

test('an import declared only in a dev group is flagged when production code imports it', () => {
  const plan = planDependencies(
    payload({
      manifest: manifest({ dependencyGroups: { dev: [dependency('requests>=2.31')] } }),
      thirdParty: [{ import: 'requests', files: ['src/demo_pkg/api.py'], providers: ['requests'] }],
    }),
  );
  assert.equal(plan.misplaced.length, 1);
  assert.deepEqual(plan.misplaced[0].declaredIn, ['group:dev']);
  assert.equal(plan.warnings[0].code, 'RUNTIME_DEPENDENCY_IN_DEV_GROUP');
  assert.equal(plan.suggestions[0].command, 'uv add requests');
});

test('a dev-group declaration is accepted when only tests import it', () => {
  const plan = planDependencies(
    payload({
      manifest: manifest({ dependencyGroups: { dev: [dependency('pytest>=8')] } }),
      thirdParty: [{ import: 'pytest', files: ['tests/test_api.py'], providers: ['pytest'] }],
    }),
  );
  assert.deepEqual(plan.misplaced, []);
  assert.equal(plan.warnings.length, 0);
});

test('a TYPE_CHECKING-only import is reported with its own code and a shorter suggestion', () => {
  const plan = planDependencies(
    payload({
      thirdParty: [
        {
          import: 'pandas',
          files: ['src/demo_pkg/frame.py'],
          providers: ['pandas'],
          typeCheckingOnly: true,
          typeCheckingFiles: ['src/demo_pkg/frame.py'],
        },
      ],
    }),
  );
  assert.equal(plan.undeclared.length, 1);
  assert.equal(plan.undeclared[0].typeCheckingOnly, true);
  assert.equal(plan.warnings[0].code, 'UNDECLARED_TYPE_ONLY_IMPORT');
  assert.equal(plan.suggestions[0].command, 'uv add --dev pandas');
});

test('a TYPE_CHECKING-only import may live in a dev group without being misplaced', () => {
  const plan = planDependencies(
    payload({
      manifest: manifest({ dependencyGroups: { dev: [dependency('pandas>=2')] } }),
      thirdParty: [
        {
          import: 'pandas',
          files: ['src/demo_pkg/frame.py'],
          providers: ['pandas'],
          typeCheckingOnly: true,
          typeCheckingFiles: ['src/demo_pkg/frame.py'],
        },
      ],
    }),
  );
  assert.deepEqual(plan.misplaced, []);
});

test('unused declarations are opt-in and exclude console-only tools', () => {
  const base = payload({
    manifest: manifest({
      dependencies: [dependency('unused-lib>=1'), dependency('ruff>=0.6')],
    }),
  });
  const quiet = planDependencies(base);
  assert.deepEqual(quiet.unused, []);

  const verbose = planDependencies(base, { includeUnused: true });
  assert.deepEqual(
    verbose.unused.map((entry) => entry.name),
    ['unused-lib'],
  );
  assert.equal(verbose.notes[0].code, 'UNUSED_DECLARATION');
});

test('lockfile drift is surfaced as one actionable warning', () => {
  const plan = planDependencies(
    payload({
      comparison: {
        missingFromLock: ['unused-lib'],
        unsatisfiedInLock: [{ name: 'requests', specifier: '>=2.31', locked: '2.30.0' }],
      },
    }),
  );
  assert.equal(plan.warnings.at(-1)?.code, 'LOCKFILE_DRIFT');
  assert.ok(plan.suggestions.some((entry) => entry.command === 'uv lock'));
  assert.deepEqual(plan.drift.missingFromLock, ['unused-lib']);
});

test('an unavailable provider mapping is disclosed rather than silently trusted', () => {
  const base = payload({ thirdParty: [{ import: 'numpy', files: [], providers: [] }] });
  if (base.imports) base.imports.providersUnavailable = true;
  const plan = planDependencies(base);
  assert.equal(plan.providerMappingReliable, false);
  assert.equal(plan.notes[0].code, 'PROVIDER_MAPPING_HEURISTIC');
});

test('project inspection reports packaging, lockfile, and environment problems', () => {
  const inspection = inspectProject({
    payload: payload({
      manifest: manifest({
        legacySetupPy: true,
        requirementsFiles: ['requirements.txt'],
        uvWorkspaceMembers: ['packages/a'],
      }),
      comparison: {
        requiresPythonMismatch: { manifest: '>=3.11', lock: '>=3.10' },
        missingFromLock: ['numpy'],
        unsatisfiedInLock: [{ name: 'requests', specifier: '>=2.31', locked: '2.30.0' }],
      },
    }),
    venvDir: '/proj/.venv',
    venvIgnored: false,
    hasTestsDirectory: true,
  });
  const codes = inspection.warnings.map((entry) => entry.code);
  assert.ok(codes.includes('LEGACY_PACKAGING'));
  assert.ok(codes.includes('DUPLICATE_DEPENDENCY_SOURCE'));
  assert.ok(codes.includes('REQUIRES_PYTHON_MISMATCH'));
  assert.ok(codes.includes('LOCKFILE_MISSING_DEPENDENCY'));
  assert.ok(codes.includes('LOCKFILE_UNSATISFIED_DEPENDENCY'));
  assert.ok(codes.includes('VENV_NOT_IGNORED'));
  assert.ok(inspection.notes.some((entry) => entry.code === 'UV_WORKSPACE'));
  assert.equal(inspection.dependencyCounts.runtime, 0);
  assert.equal(inspection.lock.packageCount, 0);
});

test('project inspection flags a missing manifest and an empty src layout', () => {
  const missing = inspectProject({
    payload: payload({ manifest: manifest({ pyprojectPath: null, name: null }) }),
    hasTestsDirectory: false,
  });
  assert.ok(missing.warnings.some((entry) => entry.code === 'PYPROJECT_MISSING'));
  assert.ok(missing.notes.some((entry) => entry.code === 'TESTS_DIRECTORY_MISSING'));
  assert.ok(missing.suggestions.some((entry) => entry.command === 'uv init'));

  const emptyLayout = inspectProject({
    payload: payload({ manifest: manifest({ layout: 'src', modules: [] }) }),
    hasTestsDirectory: true,
  });
  assert.ok(emptyLayout.warnings.some((entry) => entry.code === 'EMPTY_SRC_LAYOUT'));
});

test('a missing lockfile is a note with a suggested command, not a warning', () => {
  const inspection = inspectProject({
    payload: payload({
      lock: { present: false, path: null, packages: [] },
      comparison: { missingFromLock: [], unsatisfiedInLock: [], requiresPythonMismatch: null },
    }),
    venvDir: '/proj/.venv',
    venvIgnored: true,
    hasTestsDirectory: true,
  });
  assert.ok(inspection.notes.some((entry) => entry.code === 'LOCKFILE_MISSING'));
  assert.equal(inspection.warnings.length, 0);
  assert.ok(inspection.suggestions.some((entry) => entry.command === 'uv lock'));
});

test('a declared distribution that owns the import clears the undeclared warning', () => {
  // `wconfig` ships inside the distribution `wpyconf`. Only the installed
  // metadata connects the two, so without provider mapping this reported a
  // warning that declaring the correct distribution could not clear.
  const plan = planDependencies(
    payload({
      manifest: manifest({ dependencies: [dependency('wpyconf==0.2.3')] }),
      thirdParty: [{ import: 'wconfig', files: ['pkg/config.py'], providers: ['wpyconf'] }],
    }),
  );
  assert.deepEqual(plan.undeclared, []);
  assert.deepEqual(plan.suggestions, []);
  assert.equal(plan.unmappedImports, 0);
  assert.equal(plan.providerMappingReliable, true);
});

test('a genuinely undeclared import is suggested by its providing distribution', () => {
  const plan = planDependencies(
    payload({
      thirdParty: [{ import: 'wconfig', files: ['pkg/config.py'], providers: ['wpyconf'] }],
    }),
  );
  assert.equal(plan.undeclared.length, 1);
  assert.equal(plan.undeclared[0].suggestedDistribution, 'wpyconf');
  assert.equal(plan.undeclared[0].providerKnown, true);
  assert.equal(plan.suggestions[0].command, 'uv add wpyconf');
  assert.equal(plan.suggestions[0].confidence, 'high');
});

test('an unmappable import never gets a fabricated uv add command', () => {
  const plan = planDependencies(
    payload({ thirdParty: [{ import: 'wconfig', files: ['pkg/config.py'], providers: [] }] }),
  );
  assert.equal(plan.undeclared.length, 1);
  assert.equal(plan.undeclared[0].suggestedDistribution, undefined);
  assert.equal(plan.undeclared[0].providerKnown, false);
  // `uv add wconfig` would install a different package or nothing at all.
  assert.equal(
    plan.suggestions.some((entry) => entry.command !== undefined),
    false,
  );
  assert.match(plan.suggestions[0].message, /distribution names frequently disagree/);
  assert.equal(plan.suggestions[0].confidence, 'low');
  assert.ok(plan.notes.some((entry) => entry.code === 'UNMAPPED_IMPORTS'));
});

test('a static alias still supplies a name when no metadata is available', () => {
  const plan = planDependencies(
    payload({ thirdParty: [{ import: 'yaml', files: ['pkg/config.py'], providers: [] }] }),
  );
  assert.equal(plan.undeclared[0].suggestedDistribution, 'pyyaml');
  assert.equal(plan.suggestions[0].command, 'uv add pyyaml');
});

test('an interpreter that owns none of the project imports is not trusted', () => {
  // The host `python3` maps a handful of its own modules, so `providers` is not
  // empty and `providersUnavailable` is false, yet none of the project's
  // imports resolve. That combination must not be reported as reliable.
  const plan = planDependencies(
    payload({
      thirdParty: [
        { import: 'wconfig', files: ['pkg/a.py'], providers: [] },
        { import: 'wlogger', files: ['pkg/b.py'], providers: [] },
      ],
    }),
  );
  assert.equal(plan.unmappedImports, 2);
  assert.equal(plan.providerMappingReliable, false);
});

test('a partially mapped environment stays reliable but discloses the gap', () => {
  const plan = planDependencies(
    payload({
      thirdParty: [
        { import: 'yaml', files: ['pkg/a.py'], providers: ['PyYAML'] },
        { import: 'wconfig', files: ['pkg/b.py'], providers: [] },
      ],
    }),
  );
  assert.equal(plan.unmappedImports, 1);
  assert.equal(plan.providerMappingReliable, true);
  assert.ok(plan.notes.some((entry) => entry.code === 'UNMAPPED_IMPORTS'));
});
