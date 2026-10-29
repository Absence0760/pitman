// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface Platform {}
	}

	/** The frontend package version, injected by vite.config.ts (`define`). */
	const __PITMAN_VERSION__: string;
}

export {};
