import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectStaleArtifacts } from '../src/build/staleness.ts';

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'py-stale-'));
  await mkdir(join(root, 'src', 'app'), { recursive: true });
  await mkdir(join(root, 'tests'), { recursive: true });
  await mkdir(join(root, '.venv', 'lib', 'python3.12', 'site-packages'), { recursive: true });
  await writeFile(join(root, 'src', 'app', '__init__.py'), 'VALUE = 1\n');
  await writeFile(join(root, 'src', 'app', 'core.py'), 'def run():\n    return 1\n');
  await writeFile(join(root, 'tests', 'test_core.py'), 'def test_run():\n    assert True\n');
  // Sources live in the future so any artifact written "now" is stale by comparison.
  const future = new Date(Date.now() + 60_000);
  await utimes(join(root, 'src', 'app', 'core.py'), future, future);
  return root;
}

test('a coverage report older than the newest source is stale', async () => {
  const root = await createProject();
  try {
    await writeFile(join(root, '.coverage'), 'sqlite-ish payload\n');
    const report = await detectStaleArtifacts(root);
    assert.equal(report.stale, true);
    assert.equal(report.artifacts.length, 1);
    assert.equal(report.artifacts[0].code, 'STALE_COVERAGE_DATA');
    assert.match(report.artifacts[0].message, /src\/app\/core\.py/);
    assert.equal(report.artifacts[0].newestSource?.path.endsWith('core.py'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a coverage report newer than the sources is accepted', async () => {
  const root = await createProject();
  try {
    const coverage = join(root, 'coverage.xml');
    await writeFile(coverage, '<coverage/>\n');
    const later = new Date(Date.now() + 120_000);
    await utimes(coverage, later, later);
    const report = await detectStaleArtifacts(root);
    assert.equal(report.stale, false);
    assert.deepEqual(report.artifacts, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a project with no coverage artifacts is not reported as having stale data', async () => {
  const root = await createProject();
  try {
    const report = await detectStaleArtifacts(root);
    assert.equal(report.stale, false);
    assert.equal(report.incompleteReason, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a directory with no Python sources reports why staleness is unverified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'py-stale-empty-'));
  try {
    const report = await detectStaleArtifacts(root);
    assert.equal(report.stale, false);
    assert.match(report.incompleteReason ?? '', /No Python source files/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('virtual environment and cache directories do not count as sources', async () => {
  const root = await createProject();
  try {
    const cached = join(root, '.venv', 'lib', 'python3.12', 'site-packages', 'vendored.py');
    await writeFile(cached, 'X = 1\n');
    const future = new Date(Date.now() + 300_000);
    await utimes(cached, future, future);
    const report = await detectStaleArtifacts(root);
    assert.equal(report.stale, false);
    assert.equal(report.incompleteReason, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
