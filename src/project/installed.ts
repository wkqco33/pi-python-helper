import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Marker files Python seeds into a fresh virtual environment. */
const BOOTSTRAP_DISTRIBUTIONS = new Set([
  'pip',
  'setuptools',
  'wheel',
  'virtualenv',
  'distribute',
  'distlib',
  'filelock',
  'platformdirs',
]);

/**
 * Only the header block of `METADATA` is needed, and some distributions ship a
 * multi-megabyte body (full README). Reading a bounded prefix keeps the scan
 * proportional to the number of distributions rather than their size.
 */
const METADATA_HEADER_BYTES = 8192;
const MAX_DISTRIBUTIONS = 5000;

export interface InstalledDistribution {
  name: string;
  normalized: string;
  version: string;
  /** Directory name such as `httpx-0.28.1.dist-info`. */
  distInfo: string;
  /** `editable` when the distribution is a live link into the project tree. */
  source: 'editable' | 'copy' | 'unknown';
  /** True for interpreter-seeded packages such as pip, which no lock records. */
  bootstrap: boolean;
  /** Set when the version had to be recovered from the directory name. */
  recoveredFromDirectory?: boolean;
}

export interface InstalledEnvironment {
  sitePackages: string;
  distributions: InstalledDistribution[];
  count: number;
  truncated: boolean;
  warnings: string[];
}

const NORMALIZE_RE = /[-_.]+/g;

export function normalizeDistributionName(name: string): string {
  return name.replace(NORMALIZE_RE, '-').trim().toLowerCase();
}

/**
 * Locate the `site-packages` directory of a virtual environment. POSIX and
 * Windows layouts differ, and `lib64` is used on some distributions.
 */
export async function findSitePackages(venvDir: string): Promise<string | undefined> {
  const isDirectory = async (path: string): Promise<boolean> => {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  };

  const directCandidates = [join(venvDir, 'Lib', 'site-packages')];
  for (const candidate of directCandidates) {
    if (await isDirectory(candidate)) return candidate;
  }

  for (const base of [join(venvDir, 'lib'), join(venvDir, 'lib64')]) {
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'site-packages') return join(base, entry.name);
      const candidate = join(base, entry.name, 'site-packages');
      if (await isDirectory(candidate)) return candidate;
    }
  }
  return undefined;
}

async function readMetadataHeaders(
  path: string,
): Promise<{ name?: string; version?: string } | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(METADATA_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, METADATA_HEADER_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const headers: { name?: string; version?: string } = {};
    for (const line of text.split(/\r?\n/)) {
      if (line.length === 0) break; // the header block ends at the first blank line
      const match = line.match(/^([A-Za-z0-9][A-Za-z0-9-]*):\s*(.*)$/);
      if (!match) continue;
      const key = match[1].toLowerCase();
      if (key === 'name') headers.name = match[2].trim();
      else if (key === 'version') headers.version = match[2].trim();
      if (headers.name && headers.version) break;
    }
    return headers;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Recover name and version from `<name>-<version>.dist-info`. The version is the
 * final `-`-separated segment that begins with a digit, so names containing
 * hyphens or underscores still parse.
 */
export function parseDistInfoDirectory(
  directory: string,
): { name: string; version: string } | undefined {
  const stem = directory.replace(/\.dist-info$/i, '');
  const match = stem.match(/^(.+?)-(\d[^-]*)$/);
  if (!match) return undefined;
  return { name: match[1], version: match[2] };
}

async function readDistributionSource(
  distInfoPath: string,
): Promise<'editable' | 'copy' | 'unknown'> {
  let raw: string;
  try {
    const handle = await open(join(distInfoPath, 'direct_url.json'), 'r');
    try {
      const { size } = await handle.stat();
      const buffer = Buffer.alloc(Math.min(size, 8192));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      raw = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    // No direct_url.json: installed from an index, so it is a materialised copy.
    return 'copy';
  }
  try {
    const parsed = JSON.parse(raw) as { dir_info?: { editable?: boolean } };
    return parsed.dir_info?.editable ? 'editable' : 'copy';
  } catch {
    return 'unknown';
  }
}

/**
 * Read the distributions installed in a virtual environment without running
 * Python. `METADATA` carries the canonical name and version, and the
 * `dist-info` directory name is used as a fallback so a single damaged
 * distribution cannot hide the rest of the environment.
 */
export async function readInstalledDistributions(
  venvDir: string,
  options: { maxDistributions?: number } = {},
): Promise<InstalledEnvironment | undefined> {
  const limit = options.maxDistributions ?? MAX_DISTRIBUTIONS;
  const sitePackages = await findSitePackages(venvDir);
  if (!sitePackages) return undefined;

  const warnings: string[] = [];
  let entries;
  try {
    entries = await readdir(sitePackages, { withFileTypes: true });
  } catch (error) {
    return {
      sitePackages,
      distributions: [],
      count: 0,
      truncated: false,
      warnings: [
        `site-packages could not be read: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const distInfos = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.dist-info'))
    .map((entry) => entry.name)
    .sort();

  const truncated = distInfos.length > limit;
  const selected = truncated ? distInfos.slice(0, limit) : distInfos;
  if (truncated) {
    warnings.push(`Only the first ${limit} of ${distInfos.length} distributions were inspected.`);
  }

  const distributions: InstalledDistribution[] = [];
  for (const directory of selected) {
    const distInfoPath = join(sitePackages, directory);
    const headers = await readMetadataHeaders(join(distInfoPath, 'METADATA'));
    const fallback = parseDistInfoDirectory(directory);
    const rawName = headers?.name ?? fallback?.name;
    const rawVersion = headers?.version ?? fallback?.version;
    if (!rawName) {
      warnings.push(`${directory} declares no distribution name and was skipped.`);
      continue;
    }
    const normalized = normalizeDistributionName(rawName);
    distributions.push({
      name: rawName,
      normalized,
      version: rawVersion ?? '0',
      distInfo: directory,
      source: await readDistributionSource(distInfoPath),
      bootstrap: BOOTSTRAP_DISTRIBUTIONS.has(normalized),
      recoveredFromDirectory: headers?.version === undefined && fallback !== undefined,
    });
  }

  return {
    sitePackages,
    distributions,
    count: distributions.length,
    truncated,
    warnings,
  };
}
