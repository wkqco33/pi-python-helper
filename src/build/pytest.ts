export interface PytestCounts {
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  xfailed: number;
  xpassed: number;
  deselected: number;
  warnings: number;
}

export interface PytestFailure {
  /** Full node id, for example `tests/test_api.py::TestApi::test_get`. */
  test: string;
  file?: string;
  message: string;
  kind: 'FAILED' | 'ERROR';
}

export interface PytestReport {
  counts: PytestCounts;
  failures: PytestFailure[];
  summaryLine?: string;
  noTestsRan: boolean;
  /** Set when pytest never reached its summary, for example on a hard crash. */
  incomplete: boolean;
}

const EMPTY_COUNTS: PytestCounts = {
  passed: 0,
  failed: 0,
  errors: 0,
  skipped: 0,
  xfailed: 0,
  xpassed: 0,
  deselected: 0,
  warnings: 0,
};

function countFromLine(line: string, pattern: RegExp): number {
  const match = line.match(pattern);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function isSummaryLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^=+.*=+$/.test(trimmed)) return true;
  return /(?:passed|failed|error|no tests ran)/.test(trimmed) && trimmed.length < 200;
}

/**
 * Parse `pytest -q --tb=short -rf` output. The final summary line carries the
 * counts and the short test summary section carries the failing node ids.
 */
export function parsePytestOutput(stdout: string, stderr = ''): PytestReport {
  const text = `${stdout}\n${stderr}`;
  const lines = text.split(/\r?\n/);

  let summaryLine: string | undefined;
  for (const line of lines) {
    if (isSummaryLine(line)) summaryLine = line.trim();
  }

  const counted = summaryLine ?? '';
  const counts: PytestCounts = {
    passed: countFromLine(counted, /(\d+) passed/),
    failed: countFromLine(counted, /(\d+) failed/),
    errors: countFromLine(counted, /(\d+) errors?\b/),
    skipped: countFromLine(counted, /(\d+) skipped/),
    xfailed: countFromLine(counted, /(\d+) xfailed/),
    xpassed: countFromLine(counted, /(\d+) xpassed/),
    deselected: countFromLine(counted, /(\d+) deselected/),
    warnings: countFromLine(counted, /(\d+) warnings?\b/),
  };

  const noTestsRan = /no tests ran/.test(counted);

  const failures: PytestFailure[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^(FAILED|ERROR)\s+(\S+?)(?:\s+-\s+(.*))?$/);
    if (!match) continue;
    const [, kind, nodeId, message] = match;
    if (seen.has(`${kind} ${nodeId}`)) continue;
    seen.add(`${kind} ${nodeId}`);
    const fileIndex = nodeId.indexOf('::');
    failures.push({
      test: nodeId,
      file: fileIdToPath(fileIndex === -1 ? nodeId : nodeId.slice(0, fileIndex)),
      message: (message ?? '').trim(),
      kind: kind as 'FAILED' | 'ERROR',
    });
  }

  const incomplete =
    counts.passed + counts.failed + counts.errors + counts.skipped === 0 &&
    !noTestsRan &&
    !/(?:collected \d+ item|test session starts)/.test(text);

  return { counts, failures, summaryLine, noTestsRan, incomplete };
}

/** pytest prints collected node ids relative to the invocation root. */
function fileIdToPath(fileId: string): string | undefined {
  const trimmed = fileId.trim();
  return trimmed.endsWith('.py') ? trimmed : undefined;
}

export function totalTests(counts: PytestCounts): number {
  return (
    counts.passed + counts.failed + counts.errors + counts.skipped + counts.xfailed + counts.xpassed
  );
}

export function emptyCounts(): PytestCounts {
  return { ...EMPTY_COUNTS };
}
