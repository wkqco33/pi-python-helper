import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findSitePackages,
  normalizeDistributionName,
  parseDistInfoDirectory,
  readInstalledDistributions,
} from '../src/project/installed.ts';

async function writeDistInfo(
  sitePackages: string,
  directory: string,
  metadata: string | undefined,
  directUrl?: string,
): Promise<void> {
  const path = join(sitePackages, directory);
  await mkdir(path, { recursive: true });
  if (metadata !== undefined) await writeFile(join(path, 'METADATA'), metadata);
  if (directUrl !== undefined) await writeFile(join(path, 'direct_url.json'), directUrl);
}

async function createVenv(layout: 'posix' | 'windows'): Promise<string> {
  const venv = await mkdtemp(join(tmpdir(), 'py-venv-'));
  const sitePackages =
    layout === 'posix'
      ? join(venv, 'lib', 'python3.12', 'site-packages')
      : join(venv, 'Lib', 'site-packages');
  await mkdir(sitePackages, { recursive: true });
  await writeDistInfo(
    sitePackages,
    'httpx-0.28.1.dist-info',
    'Metadata-Version: 2.3\nName: httpx\nVersion: 0.28.1\n\nlong description follows\n',
  );
  await writeDistInfo(
    sitePackages,
    'python_dateutil-2.9.0.post0.dist-info',
    'Name: python-dateutil\nVersion: 2.9.0.post0\n',
  );
  // No METADATA at all: the directory name must be the fallback.
  await writeDistInfo(sitePackages, 'markdown_it_py-4.2.0.dist-info', undefined);
  // Editable local project.
  await writeDistInfo(
    sitePackages,
    'ledger-0.1.0.dist-info',
    'Name: ledger\nVersion: 0.1.0\n',
    '{"url":"file:///proj","dir_info":{"editable":true}}',
  );
  // Non-editable copy of another local package.
  await writeDistInfo(
    sitePackages,
    'copied-1.2.3.dist-info',
    'Name: copied\nVersion: 1.2.3\n',
    '{"url":"file:///other","dir_info":{"editable":false}}',
  );
  await writeDistInfo(sitePackages, 'pip-25.0.dist-info', 'Name: pip\nVersion: 25.0\n');
  // Directories that must be ignored.
  await mkdir(join(sitePackages, 'httpx'), { recursive: true });
  await mkdir(join(sitePackages, 'httpx-0.28.1.dist-info.bak'), { recursive: true });
  await writeFile(join(sitePackages, 'module.py'), 'x = 1\n');
  return venv;
}

test('dist-info directory names are parsed even with hyphens and dots', () => {
  assert.deepEqual(parseDistInfoDirectory('httpx-0.28.1.dist-info'), {
    name: 'httpx',
    version: '0.28.1',
  });
  assert.deepEqual(parseDistInfoDirectory('python_dateutil-2.9.0.post0.dist-info'), {
    name: 'python_dateutil',
    version: '2.9.0.post0',
  });
  assert.deepEqual(parseDistInfoDirectory('zope.interface-6.1.dist-info'), {
    name: 'zope.interface',
    version: '6.1',
  });
  assert.equal(parseDistInfoDirectory('not-a-distribution.dist-info'), undefined);
});

test('distribution names normalize to PEP 503 form', () => {
  assert.equal(normalizeDistributionName('python_dateutil'), 'python-dateutil');
  assert.equal(normalizeDistributionName('Markdown_It.Py'), 'markdown-it-py');
});

test('site-packages is located in both POSIX and Windows layouts', async () => {
  const posix = await createVenv('posix');
  const windows = await createVenv('windows');
  try {
    assert.match((await findSitePackages(posix)) ?? '', /lib\/python3\.12\/site-packages$/);
    assert.match((await findSitePackages(windows)) ?? '', /Lib\/site-packages$/);
    assert.equal(await findSitePackages(join(posix, 'does-not-exist')), undefined);
  } finally {
    await rm(posix, { recursive: true, force: true });
    await rm(windows, { recursive: true, force: true });
  }
});

test('installed distributions are read from METADATA headers only', async () => {
  const venv = await createVenv('posix');
  try {
    const environment = await readInstalledDistributions(venv);
    assert.ok(environment);
    assert.equal(environment.truncated, false);
    const byName = new Map(environment.distributions.map((entry) => [entry.normalized, entry]));
    assert.equal(byName.size, 6);
    assert.deepEqual(byName.get('httpx'), {
      name: 'httpx',
      normalized: 'httpx',
      version: '0.28.1',
      distInfo: 'httpx-0.28.1.dist-info',
      source: 'copy',
      bootstrap: false,
      recoveredFromDirectory: false,
    });
    assert.equal(byName.get('python-dateutil')?.version, '2.9.0.post0');
    assert.equal(byName.get('pip')?.bootstrap, true);
  } finally {
    await rm(venv, { recursive: true, force: true });
  }
});

test('a missing METADATA falls back to the directory name instead of dropping the package', async () => {
  const venv = await createVenv('posix');
  try {
    const environment = await readInstalledDistributions(venv);
    const entry = environment?.distributions.find((item) => item.normalized === 'markdown-it-py');
    assert.equal(entry?.version, '4.2.0');
    assert.equal(entry?.recoveredFromDirectory, true);
  } finally {
    await rm(venv, { recursive: true, force: true });
  }
});

test('editable and copied installs are distinguished', async () => {
  const venv = await createVenv('posix');
  try {
    const environment = await readInstalledDistributions(venv);
    const byName = new Map(environment?.distributions.map((entry) => [entry.normalized, entry]));
    assert.equal(byName.get('ledger')?.source, 'editable');
    assert.equal(byName.get('copied')?.source, 'copy');
    assert.equal(byName.get('httpx')?.source, 'copy');
  } finally {
    await rm(venv, { recursive: true, force: true });
  }
});

test('the scan is bounded and reports truncation instead of hiding it', async () => {
  const venv = await createVenv('posix');
  try {
    const environment = await readInstalledDistributions(venv, { maxDistributions: 3 });
    assert.equal(environment?.count, 3);
    assert.equal(environment?.truncated, true);
    assert.match(environment?.warnings[0] ?? '', /Only the first 3 of 6/);
  } finally {
    await rm(venv, { recursive: true, force: true });
  }
});

test('a virtual environment without site-packages yields undefined', async () => {
  const venv = await mkdtemp(join(tmpdir(), 'py-venv-empty-'));
  try {
    await mkdir(join(venv, 'bin'), { recursive: true });
    assert.equal(await readInstalledDistributions(venv), undefined);
  } finally {
    await rm(venv, { recursive: true, force: true });
  }
});
