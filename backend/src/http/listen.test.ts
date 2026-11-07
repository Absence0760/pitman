import { describe, expect, it } from 'vitest';
import { devListenOptions } from './listen.js';

describe('devListenOptions (the dev server, server.ts)', () => {
	it('listens on loopback only, on 3001, by default', () => {
		expect(devListenOptions({})).toEqual({ hostname: '127.0.0.1', port: 3001 });
		expect(devListenOptions({ PORT: '', BACKEND_HOST: '' })).toEqual({ hostname: '127.0.0.1', port: 3001 });
	});

	it('keeps the PORT override, and takes BACKEND_HOST', () => {
		expect(devListenOptions({ PORT: '4001' })).toEqual({ hostname: '127.0.0.1', port: 4001 });
		expect(devListenOptions({ BACKEND_HOST: '0.0.0.0', PORT: '3002' })).toEqual({ hostname: '0.0.0.0', port: 3002 });
	});

	it('refuses a PORT that is not a port', () => {
		for (const PORT of ['x', '70000', '-1', '3.5']) expect(() => devListenOptions({ PORT })).toThrow('PORT');
	});
});
