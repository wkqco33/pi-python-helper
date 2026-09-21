import test from 'node:test';
import assert from 'node:assert/strict';
import { DOC_PATH, SNAPSHOT_PATH, readDoc, readSnapshot } from '../scripts/api-docs/artifacts.ts';
import {
  buildParameters,
  capturePreconditions,
  captureToolResults,
  loadRegistration,
  renderToolsMarkdown,
} from '../scripts/api-docs/surface.ts';

/**
 * Guard the public surface: the tool names, their parameter schemas, the shape
 * of what they return, and the committed reference document.
 *
 * The name list is written out literally on purpose. Adding, renaming, or
 * removing a tool is a breaking change for the agent's prompt and for anyone
 * reading the reference, so it must be an explicit edit here as well as a
 * regenerated snapshot.
 */
const EXPECTED_TOOLS = [
  'py_completion_evidence',
  'py_dependency_plan',
  'py_environment',
  'py_failure_diagnose',
  'py_project_inspect',
  'py_sync',
  'py_tdd_checkpoint',
  'py_test',
  'py_test_config',
  'py_test_select',
  'py_validation_bundle',
];

test('the registered tool set matches the documented surface exactly', () => {
  const { tools } = loadRegistration();
  assert.deepEqual([...tools.keys()].sort(), EXPECTED_TOOLS);
});

test('every documented tool keeps its description, snippet, and guidelines', () => {
  const { tools } = loadRegistration();
  for (const name of EXPECTED_TOOLS) {
    const tool = tools.get(name);
    assert.ok(tool, `${name} must be registered`);
    assert.ok(tool.description.length > 20, `${name} needs a description`);
    assert.ok((tool.promptSnippet ?? '').length > 0, `${name} needs a promptSnippet`);
    for (const guideline of tool.promptGuidelines ?? []) {
      assert.ok(guideline.includes(name), `${name} guideline must name the tool: ${guideline}`);
    }
  }
});

test('the committed snapshot covers exactly the registered tools', async () => {
  const snapshot = await readSnapshot();
  assert.ok(snapshot, `${SNAPSHOT_PATH} is missing; run npm run docs`);
  assert.deepEqual(Object.keys(snapshot.tools).sort(), EXPECTED_TOOLS);
});

test('parameter schemas match the committed snapshot', async () => {
  const snapshot = await readSnapshot();
  assert.ok(snapshot);
  const { tools } = loadRegistration();
  for (const name of EXPECTED_TOOLS) {
    const tool = tools.get(name)!;
    assert.deepEqual(
      buildParameters(tool),
      snapshot.tools[name].parameters,
      `${name} parameters changed; run npm run docs and update EXPECTED_TOOLS if the tool set changed`,
    );
  }
});

test('the committed tool reference is current', async () => {
  const { tools, commands } = loadRegistration();
  const snapshot = await readSnapshot();
  const committed = await readDoc();
  assert.ok(committed, `${DOC_PATH} is missing; run npm run docs`);
  assert.equal(
    committed,
    renderToolsMarkdown(tools, snapshot, { commands }),
    `${DOC_PATH} is stale; run npm run docs`,
  );
});

test('captured return shapes match the committed snapshot', async (t) => {
  const preconditions = await capturePreconditions();
  if (!preconditions.ok) {
    t.skip(`return shapes not verified: ${preconditions.reason}`);
    return;
  }
  const snapshot = await readSnapshot();
  assert.ok(snapshot, `${SNAPSHOT_PATH} is missing; run npm run docs`);
  assert.ok(
    snapshot.envelope,
    'the committed snapshot has no captured shapes; run npm run docs on a machine with python3 and uv',
  );

  const capture = await captureToolResults();
  assert.deepEqual(
    capture.envelope,
    snapshot.envelope,
    'the shared response envelope changed; run npm run docs',
  );
  for (const name of EXPECTED_TOOLS) {
    assert.deepEqual(
      capture.data.get(name),
      snapshot.tools[name].data,
      `${name} return payload changed; run npm run docs`,
    );
  }
});
