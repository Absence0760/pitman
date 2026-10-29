import { describe, expect, it } from 'vitest';
import { ResultCache } from './cache.js';

describe('ResultCache', () => {
	it('computes once per key, and shares one computation between concurrent requests', async () => {
		const c = new ResultCache<number>(4);
		let runs = 0;
		const compute = async () => ++runs;
		const [a, b] = await Promise.all([c.get('k', compute), c.get('k', compute)]);
		expect([a, b, runs]).toEqual([1, 1, 1]);
		expect(await c.get('k', compute)).toBe(1);
		expect([c.hits, c.misses]).toEqual([2, 1]);
	});

	it('drops the least recently used entry past its size', async () => {
		const c = new ResultCache<string>(2);
		await c.get('a', async () => 'a');
		await c.get('b', async () => 'b');
		await c.get('a', async () => 'a again');
		await c.get('c', async () => 'c');
		expect(c.size).toBe(2);
		expect(await c.get('a', async () => 'recomputed')).toBe('a');
		expect(await c.get('b', async () => 'recomputed')).toBe('recomputed');
	});

	it('doesn’t keep a failure', async () => {
		const c = new ResultCache<number>(2);
		await expect(c.get('k', async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
		expect(await c.get('k', async () => 7)).toBe(7);
	});
});
