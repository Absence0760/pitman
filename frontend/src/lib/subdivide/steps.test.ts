import { describe, expect, it } from 'vitest';
import { stepId, wizardSteps, type WizardInput } from './steps.js';

const input = (overrides: Partial<WizardInput>): WizardInput => ({ stage: 1, choice: undefined, pieces: 0, problems: 0, calibration: 'none', ...overrides });

describe('wizardSteps', () => {
	it('says all five steps from the start', () => {
		const steps = wizardSteps(input({}));
		expect(steps.map((s) => [s.number, s.label, s.state])).toEqual([
			[1, 'Quaternary', 'current'],
			[2, 'Split', 'todo'],
			[3, 'Pieces', 'todo'],
			[4, 'Calibrate MAP', 'todo'],
			[5, 'Apply', 'todo']
		]);
		expect(steps[0]?.detail).toBe('Not chosen');
		expect(steps[0]?.id).toBe(stepId(1));
	});

	it('marks the steps behind as done', () => {
		const steps = wizardSteps(input({ stage: 3, choice: 'Z01A, RU 3', pieces: 2 }));
		expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'current', 'todo', 'todo']);
		expect(steps[0]?.detail).toBe('Z01A, RU 3');
		expect(steps[1]?.detail).toBe('2 pieces');
		expect(steps[2]?.detail).toBe('Every piece has a MAP');
	});

	it('counts what is left to fix', () => {
		expect(wizardSteps(input({ stage: 3, pieces: 2, problems: 1 }))[2]?.detail).toBe('1 to fix');
	});

	it('says how the calibration stands, never hiding one that did not converge', () => {
		const detail = (calibration: WizardInput['calibration']) => wizardSteps(input({ stage: 4, pieces: 2, calibration }))[3]?.detail;
		expect(detail('none')).toBe('Not calibrated');
		expect(detail('converged')).toBe('Converged');
		expect(detail('not_converged')).toBe('Not converged: your choice');
		expect(detail('accepted')).toBe('Not converged: best factor chosen');
		expect(detail('refused')).toBe('Refused: change the target');
		expect(detail('stale')).toBe('Out of date: calibrate again');
	});

	it('calls Apply ready only after a converged or chosen calibration', () => {
		const detail = (calibration: WizardInput['calibration']) => wizardSteps(input({ stage: 4, pieces: 2, calibration }))[4]?.detail;
		expect(detail('converged')).toBe('Ready');
		expect(detail('accepted')).toBe('Ready');
		expect(detail('not_converged')).toBe('After calibration');
		expect(detail('stale')).toBe('After calibration');
	});
});
