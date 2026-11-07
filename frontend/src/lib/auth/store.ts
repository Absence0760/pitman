/** The app's one session, against `PUBLIC_API_URL`. Kept apart from `session.svelte.ts` so tests build their own. */

import { API_BASE_URL } from '#lib/extend/api-base.js';
import { Session } from './session.svelte.js';

export const session = new Session({ baseUrl: API_BASE_URL });
