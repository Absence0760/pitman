/** The map's tile URLs, from the `PUBLIC_*` variables (`src/env.ts`). The only map module that reads the environment. */

import { PUBLIC_TERRAIN_URL, PUBLIC_TILES_GLYPHS_URL, PUBLIC_TILES_URL } from '$app/env/public';

export const TILES_URL: string = PUBLIC_TILES_URL;
export const GLYPHS_URL: string = PUBLIC_TILES_GLYPHS_URL;
export const TERRAIN_URL: string = PUBLIC_TERRAIN_URL;
