import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
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

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
