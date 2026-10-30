import { describe, expect, it } from 'vitest';
import { runStatus, workflowSteps, type StepInput } from './steps.js';

const base: StepInput = { years: '1920/21 to 2024/25', rainfallFiles: 3, extendedFiles: 0, run: 'idle', modesRun: 0, modesFailed: 0 };

function step(input: Partial<StepInput>, id: string) {
	const found = workflowSteps({ ...base, ...input }).find((s) => s.id === id);
	if (!found) throw new Error(`no step ${id}`);
	return found;
}

describe('workflowSteps', () => {
	it('goes network, extend, run, results and links to each section', () => {
		expect(workflowSteps(base).map((s) => s.id)).toEqual(['network-h', 'map-h', 'extend-h', 'subdivide-h', 'calibrate-h', 'run-h', 'results-output']);
	});

	it('a loaded network is done and shows its record', () => {
		expect(step({}, 'network-h')).toMatchObject({ state: 'done', detail: '1920/21 to 2024/25' });
	});

	it('the map asks for a quaternary, then shows it', () => {
		expect(step({}, 'map-h')).toMatchObject({ state: 'todo', detail: 'Pick a quaternary' });
		expect(step({ quaternary: 'Z01A' }, 'map-h')).toMatchObject({ state: 'done', detail: 'Z01A' });
	});

	it('counts the quaternaries split', () => {
		expect(step({}, 'subdivide-h')).toMatchObject({ state: 'todo', detail: 'Optional' });
		expect(step({ subdivided: 1 }, 'subdivide-h')).toMatchObject({ state: 'done', detail: '1 quaternary split' });
	});

	it('says the extension is optional until a file is extended', () => {
		expect(step({}, 'extend-h')).toMatchObject({ state: 'todo', detail: 'Optional: 3 files' });
		expect(step({ rainfallFiles: 1 }, 'extend-h').detail).toBe('Optional: 1 file');
		expect(step({ rainfallFiles: 0 }, 'extend-h')).toMatchObject({ state: 'todo', detail: 'No rainfall files' });
	});

	it('counts extended files, and is done only when all are', () => {
		expect(step({ extendedFiles: 2 }, 'extend-h')).toMatchObject({ state: 'active', detail: '2 of 3 extended' });
		expect(step({ extendedFiles: 3 }, 'extend-h').state).toBe('done');
	});

	it('follows the run', () => {
		expect(step({}, 'run-h')).toMatchObject({ state: 'todo', detail: 'Not run yet' });
		expect(step({ run: 'running' }, 'run-h')).toMatchObject({ state: 'active', detail: 'Running…' });
		expect(step({ run: 'failed' }, 'run-h')).toMatchObject({ state: 'failed', detail: 'The run stopped' });
		expect(step({ run: 'done', modesRun: 1 }, 'run-h')).toMatchObject({ state: 'done', detail: '1 mode run' });
		expect(step({ run: 'done', modesRun: 3 }, 'run-h').detail).toBe('3 modes run');
	});

	it('a partly failed run is reported as failed, with the count', () => {
		expect(step({ run: 'done', modesRun: 2, modesFailed: 1 }, 'run-h')).toMatchObject({ state: 'failed', detail: '1 of 3 modes failed' });
	});

	it('results wait for a run, and still show the modes that worked', () => {
		expect(step({}, 'results-output')).toMatchObject({ state: 'todo', detail: 'Run the network first' });
		expect(step({ run: 'done', modesRun: 1 }, 'results-output')).toMatchObject({ state: 'done', detail: 'One run' });
		expect(step({ run: 'done', modesRun: 2, modesFailed: 1 }, 'results-output')).toMatchObject({ state: 'done', detail: '2 runs side by side' });
	});
});

describe('runStatus', () => {
	it('is the run step in short', () => {
		expect(runStatus(workflowSteps({ ...base, run: 'running' }))).toEqual({ text: 'Running…', tone: 'active' });
	});
});
