/**
 * The run worker: the engine runs here, off the page's thread, so a long
 * network doesn't freeze the page. Started by `run-client.ts` with
 * `new Worker(new URL('./run.worker.ts', import.meta.url), { type: 'module' })`.
 */

import { run } from '@pitman/wrsm';
import { handleRunRequest, type RunResponse } from './run-protocol.js';

/** The part of the worker's global scope used here (the DOM lib, not the webworker lib, is in scope). */
const scope = self as unknown as {
	onmessage: ((event: MessageEvent<unknown>) => void) | null;
	postMessage(message: RunResponse): void;
};
scope.onmessage = (event) => handleRunRequest(event.data, run, (response) => scope.postMessage(response));
