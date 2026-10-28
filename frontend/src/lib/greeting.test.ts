import { describe, expect, it } from 'vitest';

import { greeting } from './greeting';

describe('greeting', () => {
	it('greets a named visitor', () => {
		expect(greeting('Ada')).toBe('Hello, Ada!');
	});

	it('trims surrounding whitespace', () => {
		expect(greeting('  Ada  ')).toBe('Hello, Ada!');
	});

	it('falls back to a generic greeting when the name is empty', () => {
		expect(greeting('   ')).toBe('Hello!');
	});
});
