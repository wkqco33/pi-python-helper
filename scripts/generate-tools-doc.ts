/**
 * Regenerate `docs/tools.md` from the live tool registrations plus the
 * committed `docs/api-surface.json`.
 *
 * Descriptions, parameters, and guidelines are read from the code, and the
 * captured return shapes come from the committed snapshot, so this needs no
 * interpreter and is safe to run in any environment.
 */
import { DOC_PATH, readSnapshot, writeDoc } from './api-docs/artifacts.ts';
import { loadRegistration, renderToolsMarkdown } from './api-docs/surface.ts';

const { tools, commands } = loadRegistration();
const snapshot = await readSnapshot();

if (!snapshot) {
  console.warn('docs/api-surface.json is missing; run scripts/generate-api-surface.ts first');
}

await writeDoc(renderToolsMarkdown(tools, snapshot, { commands }));
console.log(`wrote ${DOC_PATH} (${tools.size} tools, ${commands.length} command(s))`);
