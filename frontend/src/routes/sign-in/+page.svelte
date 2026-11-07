<!--
	Sign in with a code sent by email (A-AUTH-2): the address, then the code.
	Public (A-AUTH-1). The answer to "send a code" is the same whether or not
	the address is listed, so the screen never says which. On success it goes
	to `next` if that is a path on this site (lib/auth/next.ts), else home.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { AuthRequestError } from '#lib/auth/api.js';
	import { safeNext } from '#lib/auth/next.js';
	import { session } from '#lib/auth/store.js';
	import AppBar from '#lib/shell/AppBar.svelte';

	let step = $state<'email' | 'code'>('email');
	let email = $state('');
	let code = $state('');
	let busy = $state(false);
	let error = $state<string | undefined>();
	let sent = $state<string | undefined>();

	function fail(e: unknown) {
		error = e instanceof AuthRequestError ? e.message : 'Something went wrong. Try again.';
	}

	async function send(event: SubmitEvent) {
		event.preventDefault();
		const address = email.trim();
		if (address === '') {
			error = 'Enter your email address.';
			return;
		}
		busy = true;
		error = undefined;
		try {
			await session.requestCode(address);
			email = address;
			code = '';
			sent = `If ${address} is on Pitman’s list, a 6-digit code is on its way. It works for 10 minutes.`;
			step = 'code';
			await tick();
			document.getElementById('signin-code')?.focus();
		} catch (e) {
			fail(e);
			await tick();
			document.getElementById('signin-email')?.focus();
		} finally {
			busy = false;
		}
	}

	async function resend() {
		busy = true;
		error = undefined;
		try {
			await session.requestCode(email);
			code = '';
			sent = `A new code is on its way to ${email}. Only the newest code works.`;
		} catch (e) {
			fail(e);
		} finally {
			busy = false;
			document.getElementById('signin-code')?.focus();
		}
	}

	async function verify(event: SubmitEvent) {
		event.preventDefault();
		const typed = code.replace(/\s+/g, '');
		if (!/^\d{6}$/.test(typed)) {
			error = 'The code is 6 digits, from the email.';
			document.getElementById('signin-code')?.focus();
			return;
		}
		busy = true;
		error = undefined;
		try {
			await session.verify(email, typed);
			await goto(safeNext(new URLSearchParams(location.search).get('next')), { replaceState: true });
		} catch (e) {
			fail(e);
			document.getElementById('signin-code')?.focus();
		} finally {
			busy = false;
		}
	}

	async function differentAddress() {
		step = 'email';
		error = undefined;
		sent = undefined;
		code = '';
		await tick();
		document.getElementById('signin-email')?.focus();
	}
</script>

<svelte:head>
	<title>Sign in: Pitman</title>
	<meta name="description" content="Sign in to Pitman with a code sent to your email address." />
</svelte:head>

<AppBar />

<main id="main" tabindex="-1" class="page">
	<div class="card">
		<h1>Sign in</h1>
		{#if step === 'email'}
			<p>Pitman sends a code to your email address. Only addresses an admin has added can sign in.</p>
			<form onsubmit={send} novalidate>
				<label for="signin-email">Email address</label>
				<input
					id="signin-email"
					type="email"
					name="email"
					autocomplete="email"
					spellcheck="false"
					required
					bind:value={email}
					aria-invalid={error ? 'true' : undefined}
					aria-describedby="signin-msg"
				/>
				<div class="actions">
					<button type="submit" class="primary" disabled={busy}>Send a code</button>
				</div>
			</form>
		{:else}
			<p class="sent">{sent}</p>
			<form onsubmit={verify} novalidate>
				<label for="signin-code">Code from the email</label>
				<input
					id="signin-code"
					type="text"
					name="code"
					inputmode="numeric"
					autocomplete="one-time-code"
					pattern="[0-9]*"
					maxlength="6"
					spellcheck="false"
					required
					bind:value={code}
					aria-invalid={error ? 'true' : undefined}
					aria-describedby="signin-msg"
				/>
				<div class="actions">
					<button type="submit" class="primary" disabled={busy}>Sign in</button>
					<button type="button" onclick={resend} disabled={busy}>Send a new code</button>
					<button type="button" onclick={differentAddress} disabled={busy}>Use a different address</button>
				</div>
			</form>
		{/if}
		<!-- Always in the page, so a message added to it is heard. -->
		<p id="signin-msg" class="error" role="alert">{error ?? ''}</p>
	</div>
	<p class="note">
		Pitman keeps your email address to let you in. What it keeps, where, for how long, and your rights: <a href="/privacy">Privacy</a>. How the model works:
		<a href="/methods">Methods</a>.
	</p>
</main>

<style>
	.page {
		max-width: 32rem;
		margin: 0 auto;
		padding: 2rem 1.25rem 3rem;
	}
	h1 {
		margin: 0 0 0.75rem;
	}
	label {
		display: block;
		font-weight: 600;
		margin: 1rem 0 0.35rem;
	}
	input {
		width: 100%;
	}
	#signin-code {
		font-family: var(--font-mono);
		font-size: 1.15rem;
		letter-spacing: 0.15em;
		max-width: 12rem;
	}
	.sent {
		overflow-wrap: anywhere;
	}
	.error:empty {
		margin: 0;
	}
</style>
