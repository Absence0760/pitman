<!--
	The frame every route shares, and the sign-in gate (A-AUTH-1). Every route
	but /sign-in, /privacy and /methods asks GET /api/auth/me on load and goes
	to sign-in on a 401; so does any API call that comes back 401 later. The
	page renders meanwhile, since a signed-in user is the usual case: the gate is
	for the user's convenience, and the API refuses every data call without a
	session anyway.
-->
<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { isPublicPath, signInHref } from '#lib/auth/next.js';
	import { session } from '#lib/auth/store.js';
	import { onUnauthorized } from '#lib/auth/unauthorized.js';

	import '../app.css';

	// Svelte 5 renders child routes through a `children` snippet rather
	// than the legacy `<slot />`.
	let { children }: { children: Snippet } = $props();

	const isPublic = $derived(isPublicPath(page.url.pathname));

	function toSignIn() {
		if (isPublicPath(location.pathname)) return;
		void goto(signInHref(location.pathname + location.search + location.hash), { replaceState: true });
	}

	// A 401 from any API client: the session is gone. Navigating inside the app keeps the IndexedDB working copy.
	$effect(() =>
		onUnauthorized(() => {
			session.signedOut();
			toSignIn();
		})
	);

	// The page is prerendered, so its controls exist before the app's handlers do. Once they're attached,
	// <html data-hydrated> says so: the pickers wait for it (LoadPanel) and so do the end-to-end tests
	// (e2e/fixtures.ts), so nothing is acted on before the app can hear it.
	onMount(() => {
		document.documentElement.dataset.hydrated = 'true';
	});

	$effect(() => {
		if (isPublic) return;
		if (session.status === 'unknown') session.me().catch(() => undefined);
		else if (session.status === 'out') toSignIn();
	});
</script>

<a class="skip" href="#main">Skip to the page</a>
{@render children()}
