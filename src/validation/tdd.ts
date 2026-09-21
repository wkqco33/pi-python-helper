/**
 * Python's view of the shared TDD checkpoint.
 *
 * The ordering and token-overlap logic live in `pi-helper-core`; this module
 * only supplies which files count as production code or tests in a Python
 * project, so call sites keep their two-argument signature.
 */
import { checkTdd as coreCheckTdd, type TddSignals } from 'pi-helper-core';
import { isPythonFile, isTestFile } from '../project/paths.ts';

/** Tokens that appear in the prefix of most paths and so cannot distinguish modules. */
const PYTHON_TDD_SIGNALS: TddSignals = {
  isSourceFile: isPythonFile,
  isTestFile,
  prefixTokens: new Set(['test', 'tests', 'testing', 'src', 'lib']),
  minTokenLength: 4,
};

export function checkTdd(
  changedPaths: string[],
  testChangedPaths: string[] = [],
): import('pi-helper-core').TddCheckpoint {
  return coreCheckTdd(changedPaths, testChangedPaths, PYTHON_TDD_SIGNALS);
}

export type { TddAssociation, TddCheckpoint } from 'pi-helper-core';
