// The panel rendered on the server, for what a test without a browser can hold: it mounts on any bundle and keeps the
// section's heading and id the page links to. The flow itself is in plan.test.ts and the engine's tests.
import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import type { LoadedBundle } from '@pitman/wrsm';
import { syntheticBundle } from '#lib/network/synthetic.js';
import { ANSWER } from './fixtures.test-helper.js';
import LandUsePanel from './LandUsePanel.svelte';

vi.mock('$app/env/public', () => ({ PUBLIC_API_URL: 'http://localhost:3001' }));

describe('LandUsePanel', () => {
	it('renders its section before anything is fetched', () => {
		const bundle = syntheticBundle() as LoadedBundle;
		const { body } = render(LandUsePanel, { props: { bundle, onupdate: () => {}, client: { quaternaries: async () => ({ type: 'FeatureCollection' as const, features: [], source: 'none' }), landUse: async () => ANSWER } } });
		expect(body).toContain('id="landuse-h"');
		expect(body).toContain('Land use');
		expect(body).toContain('class="card"');
		expect(body).not.toContain('Synthetic data.');
	});
});
