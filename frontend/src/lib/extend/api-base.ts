/** The backend's base URL, from `PUBLIC_API_URL` (`src/env.ts`). The only module here that reads the environment. */

import { PUBLIC_API_URL } from '$app/env/public';

export const API_BASE_URL: string = PUBLIC_API_URL;
