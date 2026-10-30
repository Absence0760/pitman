import { describe, expect, it } from 'vitest';
import { subdivideEngine } from './engine.js';

describe('the adapter', () => {
	it('answers with a sentence, not a crash, until the engine is wired in', () => {
		expect(() => subdivideEngine.unsplitNaturalMar(undefined as never, undefined as never)).toThrow('not in this build yet (unsplitNaturalMar)');
	});
});
