import type { NetworkBundle, RunMode } from '@pitman/wrsm';
import { describe, expect, it, vi } from 'vitest';
import { fakeRun } from './fake-run.test-helper.js';
import { runInWorker, type WorkerLike } from './run-client.js';
import { handleRunRequest, type RunRequest, type RunResponse } from './run-protocol.js';
import { syntheticBundle } from './synthetic.js';

const bundle = syntheticBundle();
const modes: RunMode[] = [{ kind: 'presentDay', year: 2025 }, { kind: 'natural' }];

/** A worker that runs `handleRunRequest` in-process, asynchronously, through a structured clone (as postMessage does). */
function fakeWorker(run = fakeRun): WorkerLike & { terminated: boolean } {
	const worker: WorkerLike & { terminated: boolean } = {
		terminated: false,
		onmessage: null,
		onerror: null,
		onmessageerror: null,
		postMessage(message: RunRequest) {
			const copy = structuredClone(message);
			queueMicrotask(() => handleRunRequest(copy, run, (response) => worker.onmessage?.({ data: structuredClone(response) })));
		},
		terminate() {
			worker.terminated = true;
		}
	};
	return worker;
}

describe('handleRunRequest (the worker)', () => {
	it('reports progress, then a result, for each mode, then done', () => {
		const posted: RunResponse[] = [];
		handleRunRequest({ type: 'run', id: 7, bundle, modes }, fakeRun, (r) => posted.push(r));
		expect(posted.map((r) => r.type)).toEqual(['progress', 'result', 'progress', 'result', 'done']);
		expect(posted[0]).toEqual({ type: 'progress', id: 7, index: 0, total: 2, mode: modes[0] });
		expect(posted.every((r) => r.id === 7)).toBe(true);
	});

	it('reports a failing mode and still runs the others', () => {
		const run = (b: NetworkBundle, mode: RunMode) => {
			if (mode.kind === 'presentDay') throw new Error('no 2025 row');
			return fakeRun(b, mode);
		};
		const posted: RunResponse[] = [];
		handleRunRequest({ type: 'run', id: 1, bundle, modes }, run, (r) => posted.push(r));
		expect(posted.map((r) => r.type)).toEqual(['progress', 'error', 'progress', 'result', 'done']);
		expect(posted[1]).toMatchObject({ type: 'error', index: 0, message: 'no 2025 row' });
	});

	it('answers a malformed message with an error', () => {
		const posted: RunResponse[] = [];
		handleRunRequest({ type: 'nope' }, fakeRun, (r) => posted.push(r));
		expect(posted).toEqual([expect.objectContaining({ type: 'error', id: -1, mode: null })]);
	});
});

describe('runInWorker (the page side)', () => {
	it('returns one outcome per mode, in order, reports progress and terminates the worker', async () => {
		const worker = fakeWorker();
		const progress: number[] = [];
		const outcomes = await runInWorker(bundle, modes, { createWorker: () => worker, onProgress: (p) => progress.push(p.index) });
		expect(outcomes.map((o) => o.ok && o.result.mode)).toEqual(modes);
		expect(outcomes[0]).toEqual({ mode: modes[0], ok: true, result: fakeRun(bundle, modes[0]!) });
		expect(progress).toEqual([0, 1]);
		expect(worker.terminated).toBe(true);
	});

	it('keeps a failed mode as an outcome with its message', async () => {
		const outcomes = await runInWorker(bundle, modes, {
			createWorker: () =>
				fakeWorker(() => {
					throw new Error('run(): network routing is wired at Round 3 integration');
				})
		});
		expect(outcomes).toEqual(modes.map((mode) => ({ mode, ok: false, message: 'run(): network routing is wired at Round 3 integration' })));
	});

	it('rejects when the worker crashes', async () => {
		const worker = fakeWorker();
		worker.postMessage = () => queueMicrotask(() => worker.onerror?.({ message: 'boom' }));
		await expect(runInWorker(bundle, modes, { createWorker: () => worker })).rejects.toThrow(/The run stopped: boom/);
		expect(worker.terminated).toBe(true);
	});

	it('rejects and terminates when the request cannot be posted', async () => {
		const worker = fakeWorker();
		worker.postMessage = () => {
			throw new Error('could not be cloned');
		};
		await expect(runInWorker(bundle, modes, { createWorker: () => worker })).rejects.toThrow(/could not start: could not be cloned/);
		expect(worker.terminated).toBe(true);
	});

	it('rejects when a result cannot be deserialised', async () => {
		const worker = fakeWorker();
		worker.postMessage = () => queueMicrotask(() => worker.onmessageerror?.({}));
		await expect(runInWorker(bundle, modes, { createWorker: () => worker })).rejects.toThrow(/could not be read/);
		expect(worker.terminated).toBe(true);
	});

	it('cancels: terminates the worker and rejects with AbortError', async () => {
		const worker = fakeWorker();
		worker.postMessage = vi.fn();
		const controller = new AbortController();
		const running = runInWorker(bundle, modes, { createWorker: () => worker, signal: controller.signal });
		controller.abort();
		await expect(running).rejects.toMatchObject({ name: 'AbortError' });
		expect(worker.terminated).toBe(true);
	});

	it('ignores messages for another run', async () => {
		const worker = fakeWorker();
		const post = worker.postMessage.bind(worker);
		worker.postMessage = (message) => {
			worker.onmessage?.({ data: { type: 'done', id: message.id + 1000 } });
			post(message);
		};
		const outcomes = await runInWorker(bundle, modes, { createWorker: () => worker });
		expect(outcomes.every((o) => o.ok)).toBe(true);
	});
});
