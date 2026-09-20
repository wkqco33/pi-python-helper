import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ApiSurfaceSnapshot } from './surface.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const SNAPSHOT_PATH = `${REPO_ROOT}docs/api-surface.json`;
export const DOC_PATH = `${REPO_ROOT}docs/tools.md`;

export async function readSnapshot(): Promise<ApiSurfaceSnapshot | undefined> {
  try {
    return JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8')) as ApiSurfaceSnapshot;
  } catch {
    return undefined;
  }
}

export async function writeSnapshot(snapshot: ApiSurfaceSnapshot): Promise<void> {
  await writeFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export async function readDoc(): Promise<string | undefined> {
  try {
    return await readFile(DOC_PATH, 'utf8');
  } catch {
    return undefined;
  }
}

export async function writeDoc(markdown: string): Promise<void> {
  await writeFile(DOC_PATH, markdown);
}

/** First differing line, so a stale document is actionable rather than just "diff". */
export function firstDifference(expected: string, actual: string): string | undefined {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  for (let index = 0; index < Math.max(expectedLines.length, actualLines.length); index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return `line ${index + 1}:\n  committed: ${JSON.stringify(actualLines[index] ?? '<missing>')}\n  generated: ${JSON.stringify(expectedLines[index] ?? '<missing>')}`;
    }
  }
  return undefined;
}
