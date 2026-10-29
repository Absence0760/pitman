/**
 * Run a network in a Web Worker from the page: post one request, collect
 * the per-mode outcomes, report progress. The worker is created per run and
 * terminated after it, so an abandoned run can't keep computing.
 */

import type { NetworkBundle, RunMode, RunResult } from '@pitman/wrsm';
import type { RunRequest, RunResponse } from './run-protocol.js';

/** The part of a DOM `Worker` used here, so tests can pass a fake. */
export interface WorkerLike {
	postMessage(message: RunRequest): void;
	terminate(): void;
	onmessage: ((event: { data: RunResponse }) => void) | null;
	onerror: ((event: { message?: string }) => void) | null;
	/** A message that couldn't be deserialised. */
	onmessageerror: ((event: unknown) => void) | null;
}

export type RunOutcome =
	| { readonly mode: RunMode; readonly ok: true; readonly result: RunResult }
	| { readonly mode: RunMode; readonly ok: false; readonly message: string };

export interface RunProgress {
	/** 0-based index of the mode starting now. */
	readonly index: number;
	readonly total: number;
	readonly mode: RunMode;
}

export interface RunOptions {
	readonly onProgress?: (progress: RunProgress) => void;
	/** Aborting terminates the worker and rejects with an `AbortError`. */
	readonly signal?: AbortSignal;
	readonly createWorker?: () => WorkerLike;
}

/** The real worker (Vite bundles `run.worker.ts` as an ES module worker). */
export function createRunWorker(): WorkerLike {
	return new Worker(new URL('./run.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}

let nextId = 1;

/** Run `modes` on `bundle` in a worker: one outcome per mode, in order. */
export function runInWorker(bundle: NetworkBundle, modes: readonly RunMode[], options: RunOptions = {}): Promise<RunOutcome[]> {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new DOMException('The run was cancelled', 'AbortError'));
			return;
		}
		const worker = (options.createWorker ?? createRunWorker)();
		const outcomes: (RunOutcome | undefined)[] = modes.map(() => undefined);
		const finish = () => {
			worker.onmessage = null;
			worker.onerror = null;
			worker.onmessageerror = null;
			options.signal?.removeEventListener('abort', onAbort);
			worker.terminate();
		};
		const onAbort = () => {
			finish();
			reject(new DOMException('The run was cancelled', 'AbortError'));
		};
		options.signal?.addEventListener('abort', onAbort);
		worker.onerror = (event) => {
			finish();
			reject(new Error(`The run stopped: ${event.message || 'the worker failed to start or crashed'}`));
		};
		worker.onmessage = ({ data }) => {
			if (data.id !== id && data.id !== -1) return;
			switch (data.type) {
				case 'progress':
					options.onProgress?.({ index: data.index, total: data.total, mode: data.mode });
					break;
				case 'result':
					outcomes[data.index] = { mode: data.mode, ok: true, result: data.result };
					break;
				case 'error':
					if (data.mode === null) {
						finish();
						reject(new Error(data.message));
						return;
					}
					outcomes[data.index] = { mode: data.mode, ok: false, message: data.message };
					break;
				case 'done':
					finish();
					resolve(outcomes.map((o, k) => o ?? { mode: modes[k] as RunMode, ok: false, message: 'the worker returned no result for this mode' }));
					break;
			}
		};
		worker.onmessageerror = () => {
			finish();
			reject(new Error('The run stopped: a result from the worker could not be read'));
		};
		try {
			worker.postMessage({ type: 'run', id, bundle, modes });
		} catch (error) {
			// e.g. a DataCloneError: the bundle could not be copied to the worker.
			finish();
			reject(new Error(`The run could not start: ${(error as Error).message}`));
		}
	});
}
