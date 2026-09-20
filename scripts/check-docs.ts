/**
 * Fail when `docs/tools.md` no longer matches the live registrations.
 *
 * The verification is split from generation so CI can prove the committed
 * document is current without needing an interpreter or uv.
 */
import { DOC_PATH, firstDifference, readSnapshot, readDoc } from './api-docs/artifacts.ts';
import { loadRegistration, renderToolsMarkdown } from './api-docs/surface.ts';

const { tools, commands } = loadRegistration();
const snapshot = await readSnapshot();
const expected = renderToolsMarkdown(tools, snapshot, { commands });
const committed = await readDoc();

if (committed === undefined) {
  console.error(`${DOC_PATH} does not exist; run npm run docs`);
  process.exit(1);
}
if (committed !== expected) {
  console.error(`${DOC_PATH} is out of date. Run npm run docs.`);
  const difference = firstDifference(expected, committed);
  if (difference) console.error(difference);
  process.exit(1);
}
console.log(`${DOC_PATH} is up to date (${tools.size} tools)`);
