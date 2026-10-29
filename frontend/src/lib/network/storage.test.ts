import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODE_CHOICE } from './modes.js';
import { forgetWorkingCopy, loadWorkingCopy, storeWorkingCopy, type WorkingCopy } from './storage.js';
import { syntheticNetworkFiles } from './synthetic.js';

const copy: WorkingCopy = {
	schema: 1,
	name: 'SY',
	network: 'SY.NET',
	files: syntheticNetworkFiles(),
	storedAt: '2025-01-01T00:00:00.000Z',
	modes: DEFAULT_MODE_CHOICE
};

describe('the IndexedDB working copy', () => {
	it('is empty at first', async () => {
		expect(await loadWorkingCopy(new IDBFactory())).toBeUndefined();
	});

	it('stores, restores and forgets the copy', async () => {
		const idb = new IDBFactory();
		await storeWorkingCopy(copy, idb);
		expect(await loadWorkingCopy(idb)).toEqual(copy);
		await forgetWorkingCopy(idb);
		expect(await loadWorkingCopy(idb)).toBeUndefined();
	});

	it('keeps one copy: a new load replaces the old one', async () => {
		const idb = new IDBFactory();
		await storeWorkingCopy(copy, idb);
		await storeWorkingCopy({ ...copy, name: 'other' }, idb);
		expect((await loadWorkingCopy(idb))?.name).toBe('other');
	});

	it('ignores a stored value of an unknown shape', async () => {
		const idb = new IDBFactory();
		await storeWorkingCopy({ ...copy, schema: 2 } as unknown as WorkingCopy, idb);
		expect(await loadWorkingCopy(idb)).toBeUndefined();
	});
});
