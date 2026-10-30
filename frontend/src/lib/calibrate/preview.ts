/**
 * A rerun that follows the typing: `schedule` waits for a pause, a newer
 * request cancels whatever is waiting or running (terminating its worker, so
 * typing never queues up runs), and only the latest answer is reported.
 * Calibration runs in historical mode: development as the files give it, the
 * mode to compare with a gauge (issue #3 goal 5).
 */

import type { NetworkBundle, RunMode, RunResult } from '@pitman/wrsm';
import type { RunOptions, RunOutcome } from '#lib/network/run-client.js';

/** `runInWorker`'s shape, injected so tests use a fake. */
export type RunFunction = (bundle: NetworkBundle, modes: readonly RunMode[], options?: RunOptions) => Promise<RunOutcome[]>;

export const HISTORICAL: RunMode = { kind: 'historical' };

/** Long enough to cover typing a number, short enough to feel live. */
export const PREVIEW_DELAY_MS = 400;

export type PreviewPhase = 'idle' | 'waiting' | 'running' | 'done' | 'failed' | 'cancelled';

export interface PreviewState {
	readonly phase: PreviewPhase;
	/** The latest result, kept while a newer run is on its way. */
	readonly result?: RunResult;
	/** Why the run failed. */
	readonly message?: string;
}

export interface PreviewTimers {
	readonly set: (run: () => void, ms: number) => unknown;
	readonly clear: (handle: unknown) => void;
}

const REAL_TIMERS: PreviewTimers = {
	set: (run, ms) => setTimeout(run, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export class PreviewRun {
	#state: PreviewState = { phase: 'idle' };
	#timer: unknown;
	#controller: AbortController | undefined;
	/** Bumped by every request; an answer for an older one is ignored. */
	#request = 0;

	constructor(
		private readonly run: RunFunction,
		private readonly onchange: (state: PreviewState) => void,
		private readonly options: { readonly delayMs?: number; readonly timers?: PreviewTimers } = {}
	) {}

	get state(): PreviewState {
		return this.#state;
	}

	#set(next: PreviewState) {
		this.#state = next;
		this.onchange(next);
	}

	/** With the state's result dropped or kept. */
	#phase(phase: PreviewPhase, keep = true) {
		const result = keep ? this.#state.result : undefined;
		this.#set({ phase, ...(result && { result }) });
	}

	#stop() {
		this.#request += 1;
		const timers = this.options.timers ?? REAL_TIMERS;
		if (this.#timer !== undefined) timers.clear(this.#timer);
		this.#timer = undefined;
		this.#controller?.abort();
		this.#controller = undefined;
	}

	/** Run `bundle` after a pause in the typing. */
	schedule(bundle: NetworkBundle) {
		this.#stop();
		const request = this.#request;
		const timers = this.options.timers ?? REAL_TIMERS;
		this.#phase('waiting');
		this.#timer = timers.set(() => {
			this.#timer = undefined;
			if (request === this.#request) void this.#start(bundle, request);
		}, this.options.delayMs ?? PREVIEW_DELAY_MS);
	}

	/** Run `bundle` now. */
	now(bundle: NetworkBundle) {
		this.#stop();
		void this.#start(bundle, this.#request);
	}

	/** Stop what's waiting or running; the last result stays on show. */
	cancel() {
		const active = this.#state.phase === 'waiting' || this.#state.phase === 'running';
		this.#stop();
		if (active) this.#phase('cancelled');
	}

	/** Stop, and forget the result. */
	clear() {
		this.#stop();
		this.#phase('idle', false);
	}

	async #start(bundle: NetworkBundle, request: number) {
		const controller = new AbortController();
		this.#controller = controller;
		this.#phase('running');
		try {
			const [outcome] = await this.run(bundle, [HISTORICAL], { signal: controller.signal });
			if (request !== this.#request) return;
			this.#controller = undefined;
			if (outcome?.ok) this.#set({ phase: 'done', result: outcome.result });
			else this.#set({ phase: 'failed', message: outcome?.message ?? 'The run returned nothing.', ...(this.#state.result && { result: this.#state.result }) });
		} catch (error) {
			if (request !== this.#request || (error as Error).name === 'AbortError') return;
			this.#controller = undefined;
			this.#set({ phase: 'failed', message: (error as Error).message, ...(this.#state.result && { result: this.#state.result }) });
		}
	}
}

export interface PreviewSituation {
	readonly before: PreviewState;
	readonly after: PreviewState;
	/** How many values differ from the working copy, valid or not. */
	readonly edits: number;
	readonly valid: boolean;
}

/** The one line that says where the preview stands. */
export function previewStatus({ before, after, edits, valid }: PreviewSituation): string {
	if (before.phase === 'failed') return `The run stopped: ${before.message}`;
	if (before.phase === 'running' || before.phase === 'waiting') return 'Running the network in historical mode…';
	if (before.phase === 'cancelled') return 'The run was cancelled.';
	if (!valid) return after.result ? 'Preview paused: fix the values marked below. The figures show your last valid edits.' : 'Preview paused: fix the values marked below.';
	if (edits === 0) return 'Change a value to see what it does.';
	switch (after.phase) {
		case 'failed':
			return `The preview failed: ${after.message}`;
		case 'cancelled':
			return after.result ? 'Preview cancelled. The figures show your last finished preview.' : 'Preview cancelled.';
		case 'done':
			return `Preview of ${edits === 1 ? '1 edit' : `${edits} edits`}.`;
		default:
			return 'Updating the preview…';
	}
}
