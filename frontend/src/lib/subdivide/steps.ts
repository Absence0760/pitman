/** Where the wizard stands, said in words (WCAG 1.4.1). The five steps stay on the page; this is the list at the top. */

export type WizardStepState = 'done' | 'current' | 'todo';

export interface WizardStep {
	readonly number: number;
	readonly id: string;
	readonly label: string;
	readonly state: WizardStepState;
	readonly detail: string;
}

export interface WizardInput {
	/** The furthest step open, 1–5. */
	readonly stage: number;
	/** `Z01A, RU 3` once chosen. */
	readonly choice: string | undefined;
	readonly pieces: number;
	readonly problems: number;
	readonly calibration: 'none' | 'converged' | 'not_converged' | 'accepted' | 'refused' | 'stale';
}

export const stepId = (n: number): string => `subdivide-step-${n}`;

const CALIBRATION_WORDS: Readonly<Record<WizardInput['calibration'], string>> = {
	none: 'Not calibrated',
	converged: 'Converged',
	not_converged: 'Not converged: your choice',
	accepted: 'Not converged: best factor chosen',
	refused: 'Refused: change the target',
	stale: 'Out of date: calibrate again'
};

export function wizardSteps(input: WizardInput): readonly WizardStep[] {
	const { stage, choice, pieces, problems, calibration } = input;
	const state = (n: number): WizardStepState => (stage > n ? 'done' : stage === n ? 'current' : 'todo');
	const ready = calibration === 'converged' || calibration === 'accepted';
	return [
		{ number: 1, id: stepId(1), label: 'Quaternary', state: state(1), detail: choice ?? 'Not chosen' },
		{ number: 2, id: stepId(2), label: 'Split', state: state(2), detail: pieces > 1 ? `${pieces} pieces` : 'No split yet' },
		{ number: 3, id: stepId(3), label: 'Pieces', state: state(3), detail: pieces < 2 ? 'Nothing to review' : problems > 0 ? `${problems} to fix` : 'Every piece has a MAP' },
		{ number: 4, id: stepId(4), label: 'Calibrate MAP', state: state(4), detail: CALIBRATION_WORDS[calibration] },
		{ number: 5, id: stepId(5), label: 'Apply', state: state(5), detail: ready ? 'Ready' : 'After calibration' }
	];
}
