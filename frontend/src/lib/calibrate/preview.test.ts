import type { NetworkBundle, RunMode, RunResult } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import type { RunOptions, RunOutcome } from '#lib/network/run-client.js';
import { HISTORICAL, PREVIEW_DELAY_MS, PreviewRun, previewStatus, type PreviewPhase, type PreviewState, type PreviewTimers, type RunFunction } from './preview.js';

const bundle = (code: string) => ({ network: { code } }) as unknown as NetworkBundle;
const result = (code: string) => ({ mode: HISTORICAL, code }) as unknown as RunResult;

/** A run the test finishes by hand, recording how it was called. */
function fakeRun() {
	const calls: { bundle: NetworkBundle; modes: readonly RunMode[]; options: RunOptions | undefined; finish: (o: RunOutcome[]) => void; fail: (e: Error) => void }[] = [];
	const run: RunFunction = (b, modes, options) =>
		new Promise((resolve, reject) => {
			options?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
			calls.push({ bundle: b, modes, options, finish: resolve, fail: reject });
		});
	return { run, calls };
}

function fakeTimers() {
	const pending = new Map<number, { run: () => void; ms: number }>();
	let next = 1;
	const timers: PreviewTimers = {
		set: (run, ms) => {
			pending.set(next, { run, ms });
			return next++;
		},
		clear: (handle) => pending.delete(handle as number)
	};
	const fire = () => {
		const due = [...pending.values()];
		pending.clear();
		for (const t of due) t.run();
	};
	return { timers, pending, fire };
}

function setUp() {
	const { run, calls } = fakeRun();
	const clock = fakeTimers();
	const states: PreviewState[] = [];
	const preview = new PreviewRun(run, (s) => states.push(s), { timers: clock.timers });
	return { preview, calls, states, ...clock };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));
const ok = (code: string): RunOutcome[] => [{ mode: HISTORICAL, ok: true, result: result(code) }];

describe('PreviewRun', () => {
	it('waits for a pause in the typing before it runs', () => {
		const { preview, calls, pending, fire } = setUp();
		preview.schedule(bundle('a'));
		expect(preview.state.phase).toBe('waiting');
		expect([...pending.values()][0]?.ms).toBe(PREVIEW_DELAY_MS);
		expect(calls).toHaveLength(0);
		fire();
		expect(calls).toHaveLength(1);
		expect(preview.state.phase).toBe('running');
	});

	it('runs once, with the last values, however many edits came in the pause', () => {
		const { preview, calls, fire } = setUp();
		preview.schedule(bundle('a'));
		preview.schedule(bundle('b'));
		preview.schedule(bundle('c'));
		fire();
		expect(calls.map((c) => c.bundle.network.code)).toEqual(['c']);
	});

	it('runs in historical mode', () => {
		const { preview, calls } = setUp();
		preview.now(bundle('a'));
		expect(calls[0]?.modes).toEqual([{ kind: 'historical' }]);
	});

	it('reports the result', async () => {
		const { preview, calls } = setUp();
		preview.now(bundle('a'));
		calls[0]?.finish(ok('a'));
		await settle();
		expect(preview.state).toEqual({ phase: 'done', result: result('a') });
	});

	it('cancels a run in progress when a newer edit arrives, and ignores its answer', async () => {
		const { preview, calls, fire } = setUp();
		preview.now(bundle('a'));
		const first = calls[0];
		preview.schedule(bundle('b'));
		expect(first?.options?.signal?.aborted).toBe(true);
		fire();
		first?.finish(ok('a'));
		calls[1]?.finish(ok('b'));
		await settle();
		expect(preview.state.result).toEqual(result('b'));
	});

	it('ignores an old run that fails late', async () => {
		const { preview, calls } = setUp();
		preview.now(bundle('a'));
		const first = calls[0];
		preview.now(bundle('b'));
		first?.fail(new Error('too late'));
		calls[1]?.finish(ok('b'));
		await settle();
		expect(preview.state.phase).toBe('done');
	});

	it('cancel stops the run and keeps the last result on show', async () => {
		const { preview, calls, states } = setUp();
		preview.now(bundle('a'));
		calls[0]?.finish(ok('a'));
		await settle();
		preview.now(bundle('b'));
		preview.cancel();
		await settle();
		expect(calls[1]?.options?.signal?.aborted).toBe(true);
		expect(preview.state).toEqual({ phase: 'cancelled', result: result('a') });
		expect(states.at(-1)?.phase).toBe('cancelled');
	});

	it('cancel stops a run that was still waiting', () => {
		const { preview, calls, fire } = setUp();
		preview.schedule(bundle('a'));
		preview.cancel();
		fire();
		expect(calls).toHaveLength(0);
		expect(preview.state.phase).toBe('cancelled');
	});

	it('cancel does nothing once the run has finished', async () => {
		const { preview, calls } = setUp();
		preview.now(bundle('a'));
		calls[0]?.finish(ok('a'));
		await settle();
		preview.cancel();
		expect(preview.state.phase).toBe('done');
	});

	it('clear forgets the result', async () => {
		const { preview, calls } = setUp();
		preview.now(bundle('a'));
		calls[0]?.finish(ok('a'));
		await settle();
		preview.clear();
		expect(preview.state).toEqual({ phase: 'idle' });
	});

	it('reports a failed mode with the engine’s words, keeping the last result', async () => {
		const { preview, calls } = setUp();
		preview.now(bundle('a'));
		calls[0]?.finish(ok('a'));
		await settle();
		preview.now(bundle('b'));
		calls[1]?.finish([{ mode: HISTORICAL, ok: false, message: 'RU 1: groundwater model 1 (Hughes) is not supported yet' }]);
		await settle();
		expect(preview.state).toMatchObject({ phase: 'failed', message: expect.stringContaining('Hughes'), result: result('a') });
	});

	it('reports a worker that stops', async () => {
		const { preview, calls } = setUp();
		preview.now(bundle('a'));
		calls[0]?.fail(new Error('The run stopped: crashed'));
		await settle();
		expect(preview.state).toMatchObject({ phase: 'failed', message: 'The run stopped: crashed' });
	});

	it('reports an empty answer as a failure', async () => {
		const { preview, calls } = setUp();
		preview.now(bundle('a'));
		calls[0]?.finish([]);
		await settle();
		expect(preview.state.phase).toBe('failed');
	});
});

describe('previewStatus', () => {
	const state = (phase: PreviewPhase, extra: Partial<PreviewState> = {}): PreviewState => ({ phase, ...extra });
	const done = state('done', { result: result('a') });
	const say = (over: Partial<Parameters<typeof previewStatus>[0]>) => previewStatus({ before: done, after: state('idle'), edits: 0, valid: true, ...over });

	it('says the baseline is running first', () => {
		expect(say({ before: state('running') })).toBe('Running the network in historical mode…');
	});

	it('invites an edit when there are none', () => {
		expect(say({})).toBe('Change a value to see what it does.');
	});

	it('says a preview is paused by a bad value, and what the figures still show', () => {
		expect(say({ edits: 1, valid: false })).toBe('Preview paused: fix the values marked below.');
		expect(say({ edits: 1, valid: false, after: state('cancelled', { result: result('b') }) })).toContain('last valid edits');
	});

	it('follows the preview', () => {
		expect(say({ edits: 2, after: state('waiting') })).toBe('Updating the preview…');
		expect(say({ edits: 2, after: state('running') })).toBe('Updating the preview…');
		expect(say({ edits: 1, after: done })).toBe('Preview of 1 edit.');
		expect(say({ edits: 2, after: done })).toBe('Preview of 2 edits.');
	});

	it('says what failed', () => {
		expect(say({ before: state('failed', { message: 'no rain' }) })).toBe('The run stopped: no rain');
		expect(say({ edits: 1, after: state('failed', { message: 'no rain' }) })).toBe('The preview failed: no rain');
	});

	it('says a cancel happened', () => {
		expect(say({ before: state('cancelled') })).toBe('The run was cancelled.');
		expect(say({ edits: 1, after: state('cancelled') })).toBe('Preview cancelled.');
		expect(say({ edits: 1, after: state('cancelled', { result: result('b') }) })).toContain('last finished preview');
	});
});
