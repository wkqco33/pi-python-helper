/**
 * The bounded subprocess runner now lives in `pi-helper-core`; this module
 * keeps the local import path so no call site has to change.
 */
export { isSpawnFailure, runCommand, type RunOptions, type RunResult } from 'pi-helper-core';
