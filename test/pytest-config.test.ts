import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPytestConfiguration } from '../src/project/pytest-config.ts';
import { findTestDirectories } from '../src/project/root.ts';

test('a pyproject pytest table is configuration without reading any INI file', () => {
  const configuration = detectPytestConfiguration({
    pyprojectConfigured: true,
    iniFiles: {},
  });
  assert.deepEqual(configuration, { configured: true, sources: ['pyproject.toml'] });
});

test('pytest.ini counts even when it carries no section yet', () => {
  // pytest.ini exists only for pytest, so its presence is the signal.
  const configuration = detectPytestConfiguration({
    pyprojectConfigured: false,
    iniFiles: { 'pytest.ini': '# empty\n' },
  });
  assert.equal(configuration.configured, true);
  assert.deepEqual(configuration.sources, ['pytest.ini']);
});

test('tox.ini and setup.cfg only count when they carry a pytest section', () => {
  const withoutSection = detectPytestConfiguration({
    pyprojectConfigured: false,
    iniFiles: {
      'tox.ini': '[tox]\nenvlist = py312\n',
      'setup.cfg': '[metadata]\nname = demo\n',
    },
  });
  assert.deepEqual(withoutSection, { configured: false, sources: [] });

  const toxSection = detectPytestConfiguration({
    pyprojectConfigured: false,
    iniFiles: { 'tox.ini': '[pytest]\naddopts = -q\n' },
  });
  assert.deepEqual(toxSection, { configured: true, sources: ['tox.ini'] });

  const cfgSection = detectPytestConfiguration({
    pyprojectConfigured: false,
    iniFiles: { 'setup.cfg': '[tool:pytest]\ntestpaths = tests\n' },
  });
  assert.deepEqual(cfgSection, { configured: true, sources: ['setup.cfg'] });
});

test('every configuration source is reported so the agent can read the right file', () => {
  const configuration = detectPytestConfiguration({
    pyprojectConfigured: true,
    iniFiles: { 'pytest.ini': '[pytest]\n' },
  });
  assert.deepEqual(configuration.sources, ['pyproject.toml', 'pytest.ini']);
});

test('an absent file is not a configuration source', () => {
  const configuration = detectPytestConfiguration({
    pyprojectConfigured: false,
    iniFiles: { 'pytest.ini': undefined, 'tox.ini': undefined, 'setup.cfg': undefined },
  });
  assert.deepEqual(configuration, { configured: false, sources: [] });
});

test('a tests directory inside the package is found, not only ./tests', async () => {
  // This is the layout whose absence was reported as "no tests directory",
  // hiding hundreds of tests from selection and the TDD gate.
  const root = await mkdtemp(join(tmpdir(), 'py-tests-'));
  try {
    await mkdir(join(root, 'fastapi_server', 'tests', 'unit'), { recursive: true });
    await mkdir(join(root, 'src', 'demo', 'test'), { recursive: true });
    await mkdir(join(root, '.venv', 'lib'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'test'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'pyproject.toml'), '');

    const directories = await findTestDirectories(root);
    assert.deepEqual(directories, ['fastapi_server/tests', 'src/demo/test']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a project without tests reports none instead of guessing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'py-notests-'));
  try {
    await mkdir(join(root, 'src', 'demo'), { recursive: true });
    assert.deepEqual(await findTestDirectories(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a test directory at the root is found at depth one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'py-roottests-'));
  try {
    await mkdir(join(root, 'tests'), { recursive: true });
    assert.deepEqual(await findTestDirectories(root), ['tests']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
