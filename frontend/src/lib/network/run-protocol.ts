/**
 * Messages between the page and the run worker (`run.worker.ts`). A run
 * request carries the bundle and the modes; the worker answers with one
 * `progress` before each mode, a `result` or an `error` for it, then
 * `done`. Each mode runs on its own, so one failing mode doesn't lose the
 * others' results.
 */

import type { NetworkBundle, RunMode, RunResult } from '@pitman/wrsm';

export interface RunRequest {
	readonly type: 'run';
	readonly id: number;
	readonly bundle: NetworkBundle;
	readonly modes: readonly RunMode[];
}

export type RunResponse =
	| { readonly type: 'progress'; readonly id: number; readonly index: number; readonly total: number; readonly mode: RunMode }
	| { readonly type: 'result'; readonly id: number; readonly index: number; readonly mode: RunMode; readonly result: RunResult }
	| { readonly type: 'error'; readonly id: number; readonly index: number; readonly mode: RunMode | null; readonly message: string }
	| { readonly type: 'done'; readonly id: number };

/** The engine's run function, injected so tests use a fake (`run()` throws until Round 3 integration). */
export type RunFunction = (bundle: NetworkBundle, mode: RunMode) => RunResult;

function isRunRequest(value: unknown): value is RunRequest {
	const v = value as Partial<RunRequest> | null;
	return typeof v === 'object' && v !== null && v.type === 'run' && typeof v.id === 'number' && typeof v.bundle === 'object' && Array.isArray(v.modes);
}

/** The worker's whole job: run each mode in turn and report. */
export function handleRunRequest(message: unknown, run: RunFunction, post: (response: RunResponse) => void): void {
	if (!isRunRequest(message)) {
		post({ type: 'error', id: -1, index: -1, mode: null, message: 'the worker received a message it does not understand' });
		return;
	}
	const { id, bundle, modes } = message;
	modes.forEach((mode, index) => {
		post({ type: 'progress', id, index, total: modes.length, mode });
		try {
			post({ type: 'result', id, index, mode, result: run(bundle, mode) });
		} catch (error) {
			post({ type: 'error', id, index, mode, message: error instanceof Error ? error.message : String(error) });
		}
	});
	post({ type: 'done', id });
}
