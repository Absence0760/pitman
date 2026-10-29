// A small in-memory result cache, per Lambda instance: least recently used out first, a fixed number of
// entries, and concurrent requests for one key sharing one computation. A failed computation isn't
// kept. Results are a few KB (a CHIRPS series is ~25 KB of JSON), so the default holds a few MB.

export class ResultCache<T> {
	readonly #max: number;
	readonly #entries = new Map<string, Promise<T>>();
	hits = 0;
	misses = 0;

	constructor(max: number) {
		if (!(max >= 1)) throw new RangeError('a cache holds at least one entry');
		this.#max = max;
	}

	get size(): number {
		return this.#entries.size;
	}

	/** The cached value for `key`, or `compute()`'s, kept once it resolves. */
	get(key: string, compute: () => Promise<T>): Promise<T> {
		const hit = this.#entries.get(key);
		if (hit) {
			this.hits++;
			// Most recently used last.
			this.#entries.delete(key);
			this.#entries.set(key, hit);
			return hit;
		}
		this.misses++;
		const p = compute();
		this.#entries.set(key, p);
		p.catch(() => {
			if (this.#entries.get(key) === p) this.#entries.delete(key);
		});
		while (this.#entries.size > this.#max) this.#entries.delete(this.#entries.keys().next().value!);
		return p;
	}
}
