/**
 * The step rail's content: where a loaded network stands on the way from
 * load to results. Pure, so the wording and the states are tested here; the
 * state is always said in words as well as shown (WCAG 1.4.1).
 */

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
	/** Modes that produced results. */
	readonly modesRun: number;
	readonly modesFailed: number;
}

function extendStep({ rainfallFiles, extendedFiles }: StepInput): Pick<Step, 'detail' | 'state'> {
	if (rainfallFiles === 0) return { detail: 'No rainfall files', state: 'todo' };
	if (extendedFiles === 0) return { detail: `Optional: ${rainfallFiles} ${rainfallFiles === 1 ? 'file' : 'files'}`, state: 'todo' };
	return { detail: `${extendedFiles} of ${rainfallFiles} extended`, state: extendedFiles === rainfallFiles ? 'done' : 'active' };
}

function runStep({ run, modesRun, modesFailed }: StepInput): Pick<Step, 'detail' | 'state'> {
	if (run === 'running') return { detail: 'Running…', state: 'active' };
	if (run === 'failed') return { detail: 'The run stopped', state: 'failed' };
	if (run === 'idle') return { detail: 'Not run yet', state: 'todo' };
	if (modesFailed > 0) return { detail: `${modesFailed} of ${modesRun + modesFailed} modes failed`, state: 'failed' };
	return { detail: modesRun === 1 ? '1 mode run' : `${modesRun} modes run`, state: 'done' };
}

function resultsStep({ modesRun }: StepInput): Pick<Step, 'detail' | 'state'> {
	if (modesRun === 0) return { detail: 'Run the network first', state: 'todo' };
	return { detail: modesRun === 1 ? 'One run' : `${modesRun} runs side by side`, state: 'done' };
}

export function workflowSteps(input: StepInput): readonly Step[] {
	return [
		{ id: 'network-h', label: 'Network', detail: input.years, state: 'done' },
		{ id: 'map-h', label: 'Map', detail: input.quaternary ?? 'Pick a quaternary', state: input.quaternary ? 'done' : 'todo' },
		{ id: 'extend-h', label: 'Extend rainfall', ...extendStep(input) },
		{ id: 'subdivide-h', label: 'Sub-divide', detail: input.subdivided ? `${input.subdivided} ${input.subdivided === 1 ? 'quaternary' : 'quaternaries'} split` : 'Optional', state: input.subdivided ? 'done' : 'todo' },
		{ id: 'tables-h', label: 'Land use', detail: 'Tables and demands', state: 'todo' },
		{ id: 'calibrate-h', label: 'Calibrate', detail: 'Optional', state: 'todo' },
		{ id: 'run-h', label: 'Run', ...runStep(input) },
		{ id: 'results-output', label: 'Results', ...resultsStep(input) }
	];
}

/** The bar's short run status, with the tone its pill takes. */
export function runStatus(steps: readonly Step[]): { readonly text: string; readonly tone: StepState } {
	const run = steps.find((s) => s.id === 'run-h');
	return { text: run?.detail ?? 'Not run yet', tone: run?.state ?? 'todo' };
}
