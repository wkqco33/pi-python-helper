import { readFileSync } from 'node:fs';

/**
 * Report the version of the installed package so tool metadata does not drift
 * from `package.json` across releases.
 */
function readPackageVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown };
    return typeof manifest.version === 'string' && manifest.version.length > 0
      ? manifest.version
      : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const TOOL_VERSION = readPackageVersion();
