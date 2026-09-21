import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { open } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { findProjectRoot, isDirectory, isFile } from '../src/project/root.ts';

export type Pi = ExtensionAPI;
export type Ctx = ExtensionContext;

/**
 * Every tool returns JSON text plus the same object in `details`, so the UI can
 * render structured results while the model reads a single stable document.
 */
export function text(value: unknown): {
  content: { type: 'text'; text: string }[];
  details: unknown;
} {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

/**
 * Accept a project directory, a `pyproject.toml` path, or nothing (the current
 * directory). Never assume the caller passed a directory.
 */
export async function resolveProjectRoot(
  cwd: string,
  requested?: string,
): Promise<string | undefined> {
  if (!requested) return findProjectRoot(cwd);
  const candidate = resolve(cwd, requested);
  if ((await isFile(candidate)) && basename(candidate) === 'pyproject.toml') {
    return dirname(candidate);
  }
  if ((await isFile(candidate)) && basename(candidate) === 'uv.lock') {
    return dirname(candidate);
  }
  if (await isDirectory(candidate)) return (await findProjectRoot(candidate)) ?? candidate;
  return undefined;
}

export async function hasDirectory(path: string): Promise<boolean> {
  return isDirectory(path);
}

/**
 * Read a small configuration file, or `undefined` when it is absent.
 *
 * The read is bounded because `setup.cfg` and `tox.ini` can be arbitrarily
 * large and only a section header is needed from them.
 */
export async function readTextIfExists(
  path: string,
  maxBytes = 64 * 1024,
): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
