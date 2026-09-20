import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
  stdin?: string;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

function appendLimited(current: string, chunk: string, maxBytes: number): [string, boolean] {
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf8') <= maxBytes) return [next, false];
  return [Buffer.from(next, 'utf8').subarray(0, maxBytes).toString('utf8'), true];
}

/**
 * Single bounded subprocess entry point. User-supplied paths and package names
 * must always reach the process through `args`, never through a shell string,
 * and every call must stay inside a timeout and an output cap.
 */
export async function runCommand(
  executable: string,
  args: string[],
  options: RunOptions,
): Promise<RunResult> {
  const maxBytes = options.maxBytes ?? 100 * 1024;
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (options.stdin !== undefined) child.stdin.write(options.stdin);
  child.stdin.end();

  let stdout = '';
  let stderr = '';
  let truncated = false;
  let timedOut = false;
  let cancelled = false;
  let spawnError: Error | undefined;
  const onAbort = () => {
    cancelled = true;
    terminate(child);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        terminate(child);
      }, options.timeoutMs)
    : undefined;

  child.on('error', (error) => {
    spawnError = error;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    const [next, wasTruncated] = appendLimited(stdout, chunk.toString(), maxBytes);
    stdout = next;
    truncated ||= wasTruncated;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const [next, wasTruncated] = appendLimited(stderr, chunk.toString(), maxBytes);
    stderr = next;
    truncated ||= wasTruncated;
  });
  const [code] = await new Promise<[number | null]>((resolve) => {
    child.once('close', (exitCode) => resolve([exitCode]));
  });
  if (timeout) clearTimeout(timeout);
  options.signal?.removeEventListener('abort', onAbort);
  if (spawnError) stderr = `${stderr}${stderr ? '\n' : ''}${spawnError.message}`;
  return { code, stdout, stderr, timedOut, cancelled, truncated };
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}
