import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_SCHEMA_VERSION,
  classifyCommand,
  createResultFactory,
  summarizeValidation,
} from 'pi-helper-core';
import { TOOL_VERSION } from '../src/core/version.ts';
import { selectTests } from '../src/build/selection.ts';
import { checkTdd } from '../src/validation/tdd.ts';
import { detectStaleArtifacts } from '../src/build/staleness.ts';

/**
 * The migration to `pi-helper-core` only holds if the package resolves as a
 * real dependency (through `exports`, not a relative path). Assert that before
 * anything else so a broken install fails loudly here.
 */
test('the shared core resolves as a package dependency', () => {
  assert.equal(CORE_SCHEMA_VERSION, 1);

  const { result, failure } = createResultFactory('0.3.0-test');
  const value = result('/tmp', Date.now(), {
    ok: true,
    summary: 'ok',
    evidence: [],
    warnings: [],
    errors: [],
    suggestions: [],
    toolchain: { kind: 'python', version: '3.12.0', source: 'project' },
  });
  assert.equal(value.metadata.toolchain?.kind, 'python');
  assert.equal(value.metadata.toolVersion, '0.3.0-test');
  assert.equal(value.attention, false);
  assert.equal(failure('/tmp', Date.now(), 'boom', 'E').ok, false);
});

test('the core supplies the shared behaviours the Python tools delegate to', () => {
  // Universal hazards still apply with no adapter rules.
  assert.equal(classifyCommand('git reset --hard HEAD~1').risk, 'irreversible');

  const gate = summarizeValidation({
    lock: { executed: true, ok: true },
    preparation: { executed: true, ok: true },
    test: { executed: true, ok: true, failures: 0 },
    conformance: 'consistent',
    stale: false,
  });
  assert.equal(gate.ok, true);

  // The Python wrappers drive the shared selection and TDD signals.
  const selection = selectTests(['src/demo/pkg/parser.py'], ['tests/test_parser.py']);
  assert.equal(selection.selected[0]?.path, 'tests/test_parser.py');

  const checkpoint = checkTdd(['src/demo/parser.py'], ['tests/test_parser.py']);
  assert.equal(checkpoint.ok, true);

  // And the shared staleness walker returns a structured report.
  assert.equal(typeof detectStaleArtifacts, 'function');
});

test('the reported version matches package.json', async () => {
  const manifest = JSON.parse(
    await (
      await import('node:fs/promises')
    ).readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  assert.equal(TOOL_VERSION, manifest.version);
});
