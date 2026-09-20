/**
 * Regenerate `docs/api-surface.json`.
 *
 * Run with a Python 3 interpreter and uv on PATH so the return shapes can be
 * captured; without them the snapshot keeps the tool list and the parameter
 * schemas but drops the captured shapes.
 */
import { SNAPSHOT_PATH, writeSnapshot } from './api-docs/artifacts.ts';
import { buildSnapshot, capturePreconditions } from './api-docs/surface.ts';

const preconditions = await capturePreconditions();
const snapshot = await buildSnapshot();
await writeSnapshot(snapshot);

const toolCount = Object.keys(snapshot.tools).length;
if (preconditions.ok) {
  console.log(`wrote ${SNAPSHOT_PATH} (${toolCount} tools, return shapes captured)`);
} else {
  console.warn(
    `wrote ${SNAPSHOT_PATH} (${toolCount} tools, return shapes NOT captured: ${preconditions.reason})`,
  );
  console.warn('run this again on a machine with python3 and uv to capture full shapes');
}
