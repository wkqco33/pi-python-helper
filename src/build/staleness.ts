/**
 * Python's staleness spec over the shared `detectStaleArtifacts` walker.
 *
 * Python invalidates bytecode automatically and pytest installs nothing, so a
 * stale coverage report is the one artifact that can make a passing run
 * describe the wrong code. The walk and mtime comparison live in
 * `pi-helper-core`; this module names the sources and artifacts.
 */
import {
  detectStaleArtifacts as coreDetectStaleArtifacts,
  type StaleArtifact,
  type StalenessSpec,
} from 'pi-helper-core';

export type { StaleArtifact };

export interface PythonStalenessReport {
  stale: boolean;
  artifacts: StaleArtifact[];
  /** Populated when the check could not be completed, so `stale: false` is not overclaimed. */
  incompleteReason?: string;
}

const PYTHON_SPEC: StalenessSpec = {
  sourceExtensions: ['.py'],
  artifacts: [
    { name: '.coverage', code: 'STALE_COVERAGE_DATA', describe: 'coverage results' },
    { name: 'coverage.xml', code: 'STALE_COVERAGE_DATA', describe: 'coverage results' },
  ],
  // `.venv`/`venv` are not in the core's universal ignore list because they are
  // Python-specific; caches and build trees already are.
  ignoredDirectories: new Set(['.venv', 'venv']),
};

export async function detectStaleArtifacts(root: string): Promise<PythonStalenessReport> {
  const report = await coreDetectStaleArtifacts(root, PYTHON_SPEC);
  if (report.incompleteReason?.startsWith('No source file')) {
    return { ...report, incompleteReason: 'No Python source files were found.' };
  }
  return report;
}
