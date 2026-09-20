import test from 'node:test';
import assert from 'node:assert/strict';
import { compareInstalledConformance } from '../src/project/conformance.ts';
import type { InstalledDistribution, InstalledEnvironment } from '../src/project/installed.ts';
import type { LockPackage, LockSection } from '../src/project/scanner.ts';

function lockPackage(
  name: string,
  version: string,
  source: string | null = 'registry',
  dependencies: { name: string; marker?: string | null }[] = [],
): LockPackage {
  return {
    name,
    normalized: name.replace(/[-_.]+/g, '-').toLowerCase(),
    version,
    source,
    dependencies: dependencies.map((edge) => ({
      name: edge.name,
      normalized: edge.name.replace(/[-_.]+/g, '-').toLowerCase(),
      marker: edge.marker ?? null,
    })),
  };
}

function lock(packages: LockPackage[], requiresPython = '>=3.11'): LockSection {
  return {
    path: '/proj/uv.lock',
    present: true,
    version: 1,
    revision: 2,
    requiresPython,
    packages,
    warnings: [],
  };
}

function installedEntry(
  name: string,
  version: string,
  source: InstalledDistribution['source'] = 'copy',
  bootstrap = false,
): InstalledDistribution {
  const normalized = name.replace(/[-_.]+/g, '-').toLowerCase();
  return {
    name,
    normalized,
    version,
    distInfo: `${name}-${version}.dist-info`,
    source,
    bootstrap,
  };
}

function environment(
  distributions: InstalledDistribution[],
  truncated = false,
): InstalledEnvironment {
  return {
    sitePackages: '/proj/.venv/lib/python3.12/site-packages',
    distributions,
    count: distributions.length,
    truncated,
    warnings: [],
  };
}

test('matching lock and installed versions report no findings', () => {
  const report = compareInstalledConformance({
    lock: lock([lockPackage('ledger', '0.1.0', 'editable'), lockPackage('httpx', '0.28.1')]),
    installed: environment([
      installedEntry('ledger', '0.1.0', 'editable'),
      installedEntry('httpx', '0.28.1'),
    ]),
    projectName: 'ledger',
  });
  assert.equal(report.verdict, 'consistent');
  assert.equal(report.complete, true);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.checks, {
    venvPresent: true,
    lockPresent: true,
    installedScanned: true,
    projectInstalled: true,
    projectEditable: true,
  });
  assert.equal(report.counts.installedPackages, 2);
});

test('a lock update without uv sync is detected as a version mismatch', () => {
  const report = compareInstalledConformance({
    lock: lock([lockPackage('httpx', '0.28.1')]),
    installed: environment([installedEntry('httpx', '0.27.0')]),
  });
  assert.equal(report.verdict, 'drifted');
  assert.equal(report.counts.mismatched, 1);
  assert.equal(report.findings[0].code, 'INSTALLED_VERSION_MISMATCH');
  assert.equal(report.findings[0].expected, '0.28.1');
  assert.equal(report.findings[0].actual, '0.27.0');
  assert.equal(report.warnings[0].code, 'INSTALLED_VERSION_MISMATCH');
});

test('a locked package that is absent from the environment is reported', () => {
  const report = compareInstalledConformance({
    lock: lock([
      lockPackage('demo', '0.1.0', 'editable', [{ name: 'httpx' }, { name: 'anyio' }]),
      lockPackage('httpx', '0.28.1'),
      lockPackage('anyio', '4.15.1'),
    ]),
    installed: environment([
      installedEntry('httpx', '0.28.1'),
      installedEntry('demo', '0.1.0', 'editable'),
    ]),
    projectName: 'demo',
  });
  assert.equal(report.verdict, 'drifted');
  assert.equal(report.counts.missing, 1);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].code, 'INSTALLED_PACKAGE_MISSING');
  assert.equal(report.findings[0].name, 'anyio');
  assert.match(report.findings[0].message, /required unconditionally/);
});

test('a locked package declared in the default group is required even without a lock edge', () => {
  const report = compareInstalledConformance({
    lock: lock([lockPackage('pytest', '9.1.1')]),
    installed: environment([installedEntry('pip', '25.0', 'copy', true)]),
    requiredDeclarations: [{ name: 'pytest', normalized: 'pytest', marker: null }],
  });
  assert.equal(report.counts.missing, 1);
  assert.equal(report.findings[0].code, 'INSTALLED_PACKAGE_MISSING');
  assert.equal(report.findings[0].name, 'pytest');
});

test('a declaration guarded by a marker is not treated as required', () => {
  const report = compareInstalledConformance({
    lock: lock([lockPackage('tomli', '2.0.1')]),
    installed: environment([]),
    requiredDeclarations: [
      { name: 'tomli', normalized: 'tomli', marker: "python_version < '3.11'" },
    ],
  });
  assert.equal(report.verdict, 'consistent');
  assert.equal(report.counts.conditional, 1);
  assert.equal(report.counts.missing, 0);
});

test('a marker-guarded lock entry is reported as conditional, not missing', () => {
  const report = compareInstalledConformance({
    lock: lock([
      lockPackage('demo', '0.1.0', 'editable', [{ name: 'pytest' }]),
      lockPackage('pytest', '9.1.1', 'registry', [
        { name: 'colorama', marker: "sys_platform == 'win32'" },
        { name: 'iniconfig' },
      ]),
      lockPackage('colorama', '0.4.6'),
      lockPackage('iniconfig', '2.3.0'),
    ]),
    installed: environment([
      installedEntry('pytest', '9.1.1'),
      installedEntry('iniconfig', '2.3.0'),
      installedEntry('demo', '0.1.0', 'editable'),
    ]),
    projectName: 'demo',
  });
  assert.equal(report.verdict, 'consistent');
  assert.equal(report.counts.missing, 0);
  assert.equal(report.counts.conditional, 1);
  assert.deepEqual(report.findings, []);
  const note = report.notes.find((entry) => entry.code === 'CONDITIONAL_PACKAGES_ABSENT');
  assert.match(note?.message ?? '', /colorama@0\.4\.6/);
});

test('a dependency of a package that is not installed is not required', () => {
  const report = compareInstalledConformance({
    lock: lock([
      lockPackage('demo', '0.1.0', 'editable', [{ name: 'httpx' }]),
      lockPackage('httpx', '0.28.1'),
      // A platform-only branch: neither it nor its dependency is installed here.
      lockPackage('pywin32', '306', 'registry', [{ name: 'winrt' }]),
      lockPackage('winrt', '1.0'),
    ]),
    installed: environment([
      installedEntry('httpx', '0.28.1'),
      installedEntry('demo', '0.1.0', 'editable'),
    ]),
    projectName: 'demo',
  });
  assert.equal(report.verdict, 'consistent');
  assert.equal(report.counts.missing, 0);
  assert.equal(report.counts.conditional, 2);
});

test('the project itself is reported separately when it is not installed at all', () => {
  const report = compareInstalledConformance({
    lock: lock([lockPackage('ledger', '0.1.0', 'editable'), lockPackage('httpx', '0.28.1')]),
    installed: environment([installedEntry('httpx', '0.28.1')]),
    projectName: 'ledger',
  });
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].code, 'PROJECT_NOT_INSTALLED');
  assert.match(report.findings[0].message, /not importable/);
  assert.equal(report.checks.projectInstalled, false);
});

test('the project installed as a copy instead of an editable link is reported', () => {
  const report = compareInstalledConformance({
    lock: lock([lockPackage('ledger', '0.1.0', 'editable')]),
    installed: environment([installedEntry('ledger', '0.1.0', 'copy')]),
    projectName: 'ledger',
  });
  assert.equal(report.findings[0].code, 'PROJECT_INSTALLED_NOT_EDITABLE');
  assert.equal(report.checks.projectEditable, false);
  assert.match(report.findings[0].message, /stale snapshot/);
});

test('an editable project whose version moved on is not double-reported as drift', () => {
  const report = compareInstalledConformance({
    lock: lock([lockPackage('ledger', '0.1.0', 'editable')]),
    installed: environment([installedEntry('ledger', '0.2.0', 'editable')]),
    projectName: 'ledger',
  });
  assert.deepEqual(report.findings, []);
  assert.equal(report.verdict, 'consistent');
});

test('a workspace member is treated as a local project, not as a missing dependency', () => {
  const report = compareInstalledConformance({
    lock: lock([
      lockPackage('app', '0.1.0', 'editable'),
      lockPackage('libs-core', '0.1.0', 'editable'),
    ]),
    installed: environment([installedEntry('app', '0.1.0', 'editable')]),
    projectName: 'app',
  });
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].code, 'PROJECT_NOT_INSTALLED');
  assert.equal(report.findings[0].name, 'libs-core');
  assert.match(report.findings[0].message, /local project/);
  // The root project is present and editable, so its checks stay conclusive.
  assert.equal(report.checks.projectInstalled, true);
  assert.equal(report.checks.projectEditable, true);
});

test('packages installed outside the lockfile are reported as untracked', () => {
  const report = compareInstalledConformance({
    lock: lock([lockPackage('httpx', '0.28.1')]),
    installed: environment([
      installedEntry('httpx', '0.28.1'),
      installedEntry('leftover', '1.0.0'),
      installedEntry('pip', '25.0', 'copy', true),
    ]),
  });
  assert.equal(report.verdict, 'drifted');
  assert.equal(report.counts.untracked, 1);
  assert.equal(report.findings[0].code, 'INSTALLED_PACKAGE_UNTRACKED');
  assert.equal(report.findings[0].name, 'leftover');
  assert.deepEqual(
    report.notes.map((note) => note.code),
    ['BOOTSTRAP_DISTRIBUTIONS_SKIPPED'],
  );
});

test('an environment that no lockfile describes is summarised once, not per package', () => {
  const foreign = Array.from({ length: 30 }, (_, index) =>
    installedEntry(`foreign-${index}`, '1.0.0'),
  );
  const report = compareInstalledConformance({
    lock: lock([lockPackage('httpx', '0.28.1')]),
    installed: environment([installedEntry('httpx', '0.28.1'), ...foreign]),
  });
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].code, 'INSTALLED_ENVIRONMENT_INDEPENDENT');
  assert.match(report.findings[0].message, /30 of 31/);
});

test('a handful of untracked packages stays individually actionable', () => {
  const few = Array.from({ length: 19 }, (_, index) => installedEntry(`foreign-${index}`, '1.0.0'));
  const report = compareInstalledConformance({
    lock: lock([lockPackage('httpx', '0.28.1')]),
    installed: environment([installedEntry('httpx', '0.28.1'), ...few]),
  });
  assert.equal(report.findings.length, 19);
  assert.ok(report.findings.every((finding) => finding.code === 'INSTALLED_PACKAGE_UNTRACKED'));
});

test('a version recovered from the directory name is disclosed', () => {
  const entry = installedEntry('markdown-it-py', '4.2.0');
  entry.recoveredFromDirectory = true;
  const report = compareInstalledConformance({
    lock: lock([lockPackage('markdown-it-py', '4.2.0')]),
    installed: environment([entry]),
  });
  assert.equal(report.verdict, 'consistent');
  assert.deepEqual(
    report.notes.map((note) => note.code),
    ['VERSION_FROM_DIRECTORY_NAME'],
  );
});

test('no environment or no lockfile yields unverifiable, never a silent pass', () => {
  const noVenv = compareInstalledConformance({ lock: lock([]) });
  assert.equal(noVenv.verdict, 'unverifiable');
  assert.equal(noVenv.complete, false);
  assert.equal(noVenv.checks.venvPresent, false);

  const noLock = compareInstalledConformance({
    lock: { ...lock([]), present: false, path: null },
    installed: environment([installedEntry('httpx', '0.28.1')]),
  });
  assert.equal(noLock.verdict, 'unverifiable');
  assert.equal(noLock.checks.lockPresent, false);
  assert.match(noLock.reason, /uv\.lock is missing/);
});

test('a truncated scan cannot claim the environment is consistent', () => {
  const report = compareInstalledConformance({
    lock: lock([lockPackage('httpx', '0.28.1')]),
    installed: environment([installedEntry('httpx', '0.28.1')], true),
  });
  assert.equal(report.verdict, 'unverifiable');
  assert.equal(report.complete, false);
  assert.match(report.reason, /truncated/);
});
