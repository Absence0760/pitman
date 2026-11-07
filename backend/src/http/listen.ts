// Where the local dev server listens (server.ts; the Lambda has no listener). Loopback by default: the dev
// server runs with committed dev keys and AUTH_DEV_COOKIE, so it must not be reachable from the LAN.
// BACKEND_HOST overrides it (e.g. 0.0.0.0 inside a container), PORT the port.
export const DEFAULT_DEV_HOST = '127.0.0.1';
export const DEFAULT_DEV_PORT = 3001;

export function devListenOptions(env: Record<string, string | undefined>): { hostname: string; port: number } {
	const port = Number(env.PORT || DEFAULT_DEV_PORT);
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT is not a port number');
	return { hostname: env.BACKEND_HOST || DEFAULT_DEV_HOST, port };
}
