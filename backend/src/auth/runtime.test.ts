// POST /auth/code's floor (runtime.ts): auth-kit's 1 s default, now that the request sends no mail (issue
// #30). The proof that a listed and an unlisted address do the same work, store calls and one enqueue of
// one size, is in routes.test.ts; this pins the number and that a runtime starts with it.
import { cryptoRandom, DEFAULT_MIN_LATENCY_MS, memoryStore, randomSecret } from '@absence0760/auth-kit';
import { describe, expect, it } from 'vitest';
import { guardLogs } from '../__tests__/logGuard.js';
import { CODE_REQUEST_MIN_LATENCY_MS, createAuthRuntime } from './runtime.js';

guardLogs();

describe("POST /auth/code's floor", () => {
	it("is auth-kit's default, 1 s", () => {
		expect(CODE_REQUEST_MIN_LATENCY_MS).toBe(DEFAULT_MIN_LATENCY_MS);
		expect(CODE_REQUEST_MIN_LATENCY_MS).toBe(1_000);
	});

	it('is the runtime default, and a test may still pass its own', () => {
		const parts = { store: memoryStore(), codeKey: randomSecret(cryptoRandom), sessionKey: randomSecret(cryptoRandom), mail: async () => undefined };
		const runtime = createAuthRuntime(parts);
		expect(runtime.ready && runtime.latency.minMs).toBe(CODE_REQUEST_MIN_LATENCY_MS);
		const own = createAuthRuntime({ ...parts, minLatencyMs: 10 });
		expect(own.ready && own.latency.minMs).toBe(10);
	});
});
