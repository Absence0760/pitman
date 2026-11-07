// POST /auth/code's floor (runtime.ts): it must cover the slowest SES send, or a listed address (which
// sends mail inside the floor) answers later than an unlisted one. Raise the SES options and this fails
// until the floor moves with them.
import { cryptoRandom, DEFAULT_MIN_LATENCY_MS, memoryStore, randomSecret } from '@absence0760/auth-kit';
import { describe, expect, it } from 'vitest';
import { guardLogs } from '../__tests__/logGuard.js';
import { SES_CLIENT_OPTIONS, SES_RETRY_BACKOFF_MAX_MS, SES_SEND_WORST_CASE_MS } from './mail.js';
import { CODE_REQUEST_MIN_LATENCY_MS, createAuthRuntime } from './runtime.js';

guardLogs();

describe("POST /auth/code's floor", () => {
	it('sits above the SES worst case, whatever the SES options say', () => {
		const { maxAttempts, requestHandler } = SES_CLIENT_OPTIONS;
		const worst = maxAttempts * (requestHandler.connectionTimeout + requestHandler.requestTimeout) + (maxAttempts - 1) * SES_RETRY_BACKOFF_MAX_MS;
		expect(SES_SEND_WORST_CASE_MS).toBe(worst);
		expect(CODE_REQUEST_MIN_LATENCY_MS).toBeGreaterThan(worst);
		expect(CODE_REQUEST_MIN_LATENCY_MS).toBeGreaterThanOrEqual(DEFAULT_MIN_LATENCY_MS);
		expect(CODE_REQUEST_MIN_LATENCY_MS).toBe(4_500);
	});

	it('is the runtime default instead of auth-kit 1 s one, and a test may still pass its own', () => {
		const parts = { store: memoryStore(), codeKey: randomSecret(cryptoRandom), sessionKey: randomSecret(cryptoRandom), mail: async () => undefined };
		const runtime = createAuthRuntime(parts);
		expect(runtime.ready && runtime.latency.minMs).toBe(CODE_REQUEST_MIN_LATENCY_MS);
		const own = createAuthRuntime({ ...parts, minLatencyMs: 10 });
		expect(own.ready && own.latency.minMs).toBe(10);
	});
});
