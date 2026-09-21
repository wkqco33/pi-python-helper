import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uvSyncFrozen } from '../src/build/commands.ts';
import { describeRemovals, parseSyncOutput } from '../src/build/sync.ts';
import { checkRequiredTools } from '../src/environment/tools.ts';

/**
 * uv reports removals as a per-package inventory. These fixtures mirror the
 * real output that removed a project's own dev tooling.
 */
const REMOVAL_OUTPUT = [
  'Resolved 78 packages in 627ms',
  'Uninstalled 10 packages in 305ms',
  ' - coverage==7.15.4',
  ' - iniconfig==2.3.0',
  ' - pytest==9.0.3',
  ' - ruff==0.15.5',
  'Audited 66 packages in 2ms',
].join('\n');

test('the sync command requests every extra so declared dev tooling survives', () => {
  // `--all-groups` alone covers [dependency-groups]; extras are removed unless
  // they are requested, so the default must include them.
  assert.deepEqual(uvSyncFrozen('/tmp/project').args, [
    'sync',
    '--frozen',
    '--all-groups',
    '--all-extras',
  ]);
  assert.equal(uvSyncFrozen('/tmp/project').risk, 'mutating');
});

test('extras can be declined explicitly', () => {
  assert.deepEqual(uvSyncFrozen('/tmp/project', { extras: 'none' }).args, [
    'sync',
    '--frozen',
    '--all-groups',
  ]);
  assert.deepEqual(uvSyncFrozen('/tmp/project', { extras: 'all' }).args, [
    'sync',
    '--frozen',
    '--all-groups',
    '--all-extras',
  ]);
});

test('the sync inventory separates removals from installs', () => {
  const inventory = parseSyncOutput(REMOVAL_OUTPUT);
  assert.deepEqual(inventory.uninstalled, ['coverage', 'iniconfig', 'pytest', 'ruff']);
  assert.deepEqual(inventory.installed, []);
  assert.match(inventory.summaryLines.join(' '), /Uninstalled 10 packages/);
});

test('an install inventory is parsed with versions stripped', () => {
  const inventory = parseSyncOutput(
    ['Installed 3 packages in 42ms', ' + pyright==1.1.411', ' + pytest==9.0.3'].join('\n'),
  );
  assert.deepEqual(inventory.installed, ['pyright', 'pytest']);
  assert.deepEqual(inventory.uninstalled, []);
});

test('a package line outside a counted section is ignored', () => {
  // Without the header the ` +/-` lines cannot be attributed to a direction, and
  // guessing would invent removals that never happened.
  const inventory = parseSyncOutput([' - pytest==9.0.3'].join('\n'));
  assert.deepEqual(inventory.installed, []);
  assert.deepEqual(inventory.uninstalled, []);
});

test('an unrelated uv output yields an empty inventory instead of a false one', () => {
  const inventory = parseSyncOutput('Resolved 78 packages in 3ms\nAudited 78 packages in 3ms\n');
  assert.deepEqual(inventory, {
    installed: [],
    uninstalled: [],
    summaryLines: ['Resolved 78 packages in 3ms', 'Audited 78 packages in 3ms'],
  });
  assert.equal(describeRemovals(inventory), undefined);
});

test('removals are summarised so a later missing-tool failure has a cause', () => {
  const message = describeRemovals(parseSyncOutput(REMOVAL_OUTPUT));
  assert.ok(message);
  assert.match(message, /removed 4 distribution\(s\)/);
  assert.match(message, /pytest/);
});

test('a long removal list is truncated rather than dumped whole', () => {
  const lines = ['Uninstalled 20 packages in 12ms'];
  for (let index = 0; index < 20; index += 1) lines.push(` - package-${index}==1.0.0`);
  const message = describeRemovals(parseSyncOutput(lines.join('\n')));
  assert.ok(message);
  assert.match(message, /\+8\)/);
});

test('checkRequiredTools reports the tools a sync left behind', async () => {
  const venv = await mkdtemp(join(tmpdir(), 'py-sync-venv-'));
  try {
    assert.deepEqual(await checkRequiredTools(undefined, ['pytest']), {
      checked: false,
      missing: [],
    });

    await mkdir(join(venv, 'bin'), { recursive: true });
    // The venv exists but the tool was uninstalled by the sync.
    assert.deepEqual(await checkRequiredTools(venv, ['pytest']), {
      checked: true,
      venvDir: venv,
      missing: ['pytest'],
    });

    const script = join(venv, 'bin', 'pytest');
    await writeFile(script, '#!/bin/sh\nexit 0\n');
    await chmod(script, 0o755);
    assert.deepEqual(await checkRequiredTools(venv, ['pytest']), {
      checked: true,
      venvDir: venv,
      missing: [],
    });
  } finally {
    await rm(venv, { recursive: true, force: true });
  }
});
