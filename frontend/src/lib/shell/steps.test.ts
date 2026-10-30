import { describe, expect, it } from 'vitest';
import { runStatus, sidecarProgress, workflowSteps, type StepInput } from './steps.js';

const base: StepInput = { years: '1920/21 to 2024/25', rainfallFiles: 3, extendedFiles: 0, run: 'idle', modesRun: 0, modesFailed: 0 };

function step(input: Partial<StepInput>, id: string) {
	const found = workflowSteps({ ...base, ...input }).find((s) => s.id === id);
	if (!found) throw new Error(`no step ${id}`);
	return found;
}

describe('workflowSteps', () => {
	it('goes network, extend, run, results and links to each section', () => {
		expect(workflowSteps(base).map((s) => s.id)).toEqual(['network-h', 'map-h', 'extend-h', 'subdivide-h', 'landuse-h', 'tables-h', 'demand-h', 'calibrate-h', 'run-h', 'results-output']);
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

	it('after a change that cleared the results it says to run again, not that nothing has run', () => {
		expect(step({ changed: true }, 'run-h')).toMatchObject({ state: 'todo', detail: 'Run again: the network changed' });
	});

	it('the optional steps say what the sidecar holds', () => {
		const progress = sidecarProgress({
			schema: 'pitman-sidecar',
			schemaVersion: 1,
			dams: [],
			capeFarmMapper: { fetchedOn: '2026-10-30' },
			demands: { 'SYRQ10.ABS': {} as never, 'SYRQ11.ABS': {} as never },
			values: [
				{ target: { module: { type: 'RU', number: 1 }, field: 'afforestation.areaKm2', year: 2025 }, source: { kind: 'manual', note: 'Land use: none → 3.5; Survey', date: '2026-10-30' } },
				{ target: { module: { type: 'RU', number: 1 }, field: 'pitman.ST' }, source: { kind: 'manual', note: 'Calibration: 150 → 180', date: '2026-10-30' } }
			]
		});
		expect(progress).toEqual({ rowsWritten: true, tableEdits: 1, demandsMade: 2, calibrated: 1 });
		expect(step({ progress }, 'landuse-h')).toMatchObject({ state: 'done', detail: 'Rows written' });
		expect(step({ progress }, 'tables-h')).toMatchObject({ state: 'done', detail: '1 value changed' });
		expect(step({ progress }, 'demand-h')).toMatchObject({ state: 'done', detail: '2 demands' });
		expect(step({ progress }, 'calibrate-h')).toMatchObject({ state: 'done', detail: '1 value changed' });
		expect(step({}, 'tables-h')).toMatchObject({ state: 'todo', detail: 'Optional' });
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
