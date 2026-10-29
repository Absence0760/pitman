/**
 * The IndexedDB working copy (issue #3 rule 7): the browser keeps the
 * loaded network so a reload restores it; the user's own copy is the zip
 * they download. The copy is the network's **files** (what `writeBundle`
 * gives), not the parsed objects, so it reloads through the same validation
 * and stays readable when the engine's types change.
 *
 * One copy at a time, in database `pitman`, store `working-copy`, key
 * `current`. Nothing leaves the browser.
 */

import type { BundleFiles } from './engine.js';
import { isModeChoice, type ModeChoice } from './modes.js';

const DB_NAME = 'pitman';
const DB_VERSION = 1;
const STORE = 'working-copy';
const KEY = 'current';

/** What is kept. */
export interface WorkingCopy {
	readonly schema: 1;
	/** The name the network was loaded under (zip or folder name). */
	readonly name: string;
	/** Path of the `.NET` in `files`. */
	readonly network: string;
	readonly files: BundleFiles;
	/** ISO date-time the copy was written. */
	readonly storedAt: string;
	readonly modes?: ModeChoice;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
	});
}

function open(factory: IDBFactory): Promise<IDBDatabase> {
	const req = factory.open(DB_NAME, DB_VERSION);
	req.onupgradeneeded = () => {
		if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
	};
	return request(req);
}

async function withStore<T>(factory: IDBFactory, mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	const db = await open(factory);
	try {
		const tx = db.transaction(STORE, mode);
		const result = await request(use(tx.objectStore(STORE)));
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
			tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
		});
		return result;
	} finally {
		db.close();
	}
}

/** The browser's IndexedDB, or `undefined` where there is none (prerender, some private modes). */
export function browserIndexedDB(): IDBFactory | undefined {
	return typeof indexedDB === 'undefined' ? undefined : indexedDB;
}

/** Keep `copy`, replacing any earlier one. */
export async function storeWorkingCopy(copy: WorkingCopy, factory: IDBFactory): Promise<void> {
	await withStore(factory, 'readwrite', (store) => store.put(copy, KEY));
}

function isWorkingCopy(value: unknown): value is WorkingCopy {
	const v = value as Partial<WorkingCopy> | null;
	return (
		typeof v === 'object' &&
		v !== null &&
		v.schema === 1 &&
		typeof v.name === 'string' &&
		typeof v.network === 'string' &&
		typeof v.storedAt === 'string' &&
		typeof v.files === 'object' &&
		v.files !== null &&
		Object.values(v.files).every((t) => typeof t === 'string') &&
		(v.modes === undefined || isModeChoice(v.modes))
	);
}

/** The kept copy, or `undefined` when there is none (or it is from an unknown version). */
export async function loadWorkingCopy(factory: IDBFactory): Promise<WorkingCopy | undefined> {
	const value: unknown = await withStore(factory, 'readonly', (store) => store.get(KEY));
	return isWorkingCopy(value) ? value : undefined;
}

/** Delete the kept copy. */
export async function forgetWorkingCopy(factory: IDBFactory): Promise<void> {
	await withStore(factory, 'readwrite', (store) => store.delete(KEY));
}
