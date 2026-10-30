/**
 * The step rail's content: where a loaded network stands on the way from
 * load to results. Pure, so the wording and the states are tested here; the
 * state is always said in words as well as shown (WCAG 1.4.1).
 */

import type { Sidecar } from '@pitman/wrsm';

export type StepState = 'done' | 'active' | 'failed' | 'todo';

export interface Step {
	/** The id of the heading the step's link goes to. */
	readonly id: string;
	readonly label: string;
	readonly detail: string;
	readonly state: StepState;
}

export interface StepInput {
	/** The record, as the rail shows it ("1920/21 to 2024/25"). */
	readonly years: string;
	/** The quaternary chosen on the map, if any. */
	readonly quaternary?: string | undefined;
	/** Quaternaries with an applied sub-division. */
	readonly subdivided?: number | undefined;
	readonly rainfallFiles: number;
	readonly extendedFiles: number;
	readonly run: 'idle' | 'running' | 'done' | 'failed';
	/** The network changed after a run, which cleared its results. */
	readonly changed?: boolean | undefined;
	/** What the sidecar says was done in the optional steps. */
	readonly progress?: SidecarProgress | undefined;
	/** Modes that produced results. */
	readonly modesRun: number;
	readonly modesFailed: number;
}

/** What has been done to the network beyond the extension and the split, as the sidecar records it. */
export interface SidecarProgress {
	readonly rowsWritten: boolean;
	readonly tableEdits: number;
	readonly demandsMade: number;
	readonly calibrated: number;
}

export function sidecarProgress(sidecar: Sidecar | undefined): SidecarProgress {
	const notes = (sidecar?.values ?? []).map((v) => v.source.note ?? '');
	return {
		rowsWritten: sidecar?.capeFarmMapper !== undefined || (sidecar?.dams?.length ?? 0) > 0,
		tableEdits: notes.filter((n) => n.startsWith('Land use:')).length,
		demandsMade: Object.keys(sidecar?.demands ?? {}).length,
		calibrated: notes.filter((n) => n.startsWith('Calibration:')).length
	};
}

/** An optional step: done once anything has been recorded, and saying how much. */
const optional = (count: number, what: string): Pick<Step, 'detail' | 'state'> => (count === 0 ? { detail: 'Optional', state: 'todo' } : { detail: `${count} ${what}${count === 1 ? '' : 's'}`, state: 'done' });

const valuesStep = (count: number): Pick<Step, 'detail' | 'state'> => (count === 0 ? optional(0, '') : { detail: `${count} ${count === 1 ? 'value' : 'values'} changed`, state: 'done' });

function extendStep({ rainfallFiles, extendedFiles }: StepInput): Pick<Step, 'detail' | 'state'> {
	if (rainfallFiles === 0) return { detail: 'No rainfall files', state: 'todo' };
	if (extendedFiles === 0) return { detail: `Optional: ${rainfallFiles} ${rainfallFiles === 1 ? 'file' : 'files'}`, state: 'todo' };
	return { detail: `${extendedFiles} of ${rainfallFiles} extended`, state: extendedFiles === rainfallFiles ? 'done' : 'active' };
}

function runStep({ run, changed, modesRun, modesFailed }: StepInput): Pick<Step, 'detail' | 'state'> {
	if (run === 'running') return { detail: 'Running…', state: 'active' };
	if (run === 'failed') return { detail: 'The run stopped', state: 'failed' };
	if (run === 'idle') return { detail: changed ? 'Run again: the network changed' : 'Not run yet', state: 'todo' };
	if (modesFailed > 0) return { detail: `${modesFailed} of ${modesRun + modesFailed} modes failed`, state: 'failed' };
	return { detail: modesRun === 1 ? '1 mode run' : `${modesRun} modes run`, state: 'done' };
}

function resultsStep({ modesRun }: StepInput): Pick<Step, 'detail' | 'state'> {
	if (modesRun === 0) return { detail: 'Run the network first', state: 'todo' };
	return { detail: modesRun === 1 ? 'One run' : `${modesRun} runs side by side`, state: 'done' };
}

export function workflowSteps(input: StepInput): readonly Step[] {
	const progress = input.progress ?? sidecarProgress(undefined);
	return [
		{ id: 'network-h', label: 'Network', detail: input.years, state: 'done' },
		{ id: 'map-h', label: 'Map', detail: input.quaternary ?? 'Pick a quaternary', state: input.quaternary ? 'done' : 'todo' },
		{ id: 'extend-h', label: 'Extend rainfall', ...extendStep(input) },
		{ id: 'subdivide-h', label: 'Sub-divide', detail: input.subdivided ? `${input.subdivided} ${input.subdivided === 1 ? 'quaternary' : 'quaternaries'} split` : 'Optional', state: input.subdivided ? 'done' : 'todo' },
		{ id: 'landuse-h', label: 'Fields and dams', detail: progress.rowsWritten ? 'Rows written' : 'Optional', state: progress.rowsWritten ? 'done' : 'todo' },
		{ id: 'tables-h', label: 'Land-use tables', ...valuesStep(progress.tableEdits) },
		{ id: 'demand-h', label: 'Demands', ...optional(progress.demandsMade, 'demand') },
		{ id: 'calibrate-h', label: 'Calibrate', ...valuesStep(progress.calibrated) },
		{ id: 'run-h', label: 'Run', ...runStep(input) },
		{ id: 'results-output', label: 'Results', ...resultsStep(input) }
	];
}

/** The ids of the steps that are optional, so their cards start closed. */
export const OPTIONAL_STEPS: readonly string[] = ['extend-h', 'subdivide-h', 'landuse-h', 'tables-h', 'demand-h', 'calibrate-h'];

/** The bar's short run status, with the tone its pill takes. */
export function runStatus(steps: readonly Step[]): { readonly text: string; readonly tone: StepState } {
	const run = steps.find((s) => s.id === 'run-h');
	return { text: run?.detail ?? 'Not run yet', tone: run?.state ?? 'todo' };
}
