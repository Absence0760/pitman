<!--
	Users (admins only, A-AUTH-4): who can sign in, who is an admin, and the
	recent audit log. The API holds the rules (admins only, not yourself, at
	least one admin) and says why it refuses; the page shows that sentence as
	it is. Removing someone asks first, with the focus on Keep.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { addUser, AuthRequestError, clearDeliveryProblem, listAudit, listUsers, removeUser, setAdmin, type AuditRow, type ListedUser } from '#lib/auth/api.js';
	import { actionText, actorText } from '#lib/auth/audit.js';
	import { session } from '#lib/auth/store.js';
	import { API_BASE_URL } from '#lib/extend/api-base.js';
	import { formatDateTime } from '#lib/network/format.js';
	import AppBar from '#lib/shell/AppBar.svelte';

	const AUDIT_LIMIT = 50;
	const options = { baseUrl: API_BASE_URL };

	let users = $state.raw<ListedUser[]>([]);
	let audit = $state.raw<AuditRow[]>([]);
	let loaded = $state(false);
	/** The API's refusal of the whole page (403), or why the list couldn't load. */
	let refused = $state<string | undefined>();
	let auditError = $state<string | undefined>();
	let status = $state('');
	let error = $state<string | undefined>();
	let busy = $state(false);
	let newEmail = $state('');
	let newAdmin = $state(false);
	/** The user whose removal is being confirmed. */
	let confirming = $state<string | undefined>();

	const message = (e: unknown) => (e instanceof AuthRequestError ? e.message : 'Something went wrong. Try again.');

	async function load() {
		try {
			users = await listUsers(options);
			loaded = true;
		} catch (e) {
			refused = message(e);
			return;
		}
		try {
			audit = await listAudit(AUDIT_LIMIT, options);
			auditError = undefined;
		} catch (e) {
			auditError = message(e);
		}
	}

	// Wait for the gate's answer; a non-admin never asks the API for the list.
	let started = false;
	$effect(() => {
		if (started || session.status !== 'in') return;
		started = true;
		if (session.isAdmin) void load();
	});

	async function act(what: () => Promise<string>) {
		busy = true;
		error = undefined;
		try {
			status = await what();
			await load();
		} catch (e) {
			error = message(e);
			status = '';
		} finally {
			busy = false;
		}
	}

	function add(event: SubmitEvent) {
		event.preventDefault();
		const email = newEmail.trim();
		if (email === '') {
			error = 'Enter the address to add.';
			document.getElementById('new-user-email')?.focus();
			return;
		}
		void act(async () => {
			const user = await addUser(email, newAdmin, options);
			newEmail = '';
			newAdmin = false;
			return `Added ${user.email}${user.isAdmin ? ' as an admin' : ''}. They can sign in now.`;
		});
	}

	function toggleAdmin(user: ListedUser) {
		void act(async () => {
			await setAdmin(user.id, !user.isAdmin, options);
			return user.isAdmin ? `${user.email} is no longer an admin.` : `${user.email} is now an admin.`;
		});
	}

	async function askRemove(user: ListedUser) {
		confirming = user.id;
		await tick();
		document.getElementById(`keep-${user.id}`)?.focus();
	}

	async function keep(user: ListedUser) {
		confirming = undefined;
		await tick();
		document.getElementById(`remove-${user.id}`)?.focus();
	}

	function remove(user: ListedUser) {
		confirming = undefined;
		void act(async () => {
			await removeUser(user.id, options);
			return `Removed ${user.email}. They are signed out and can’t sign in again.`;
		}).then(() => document.getElementById('main')?.focus());
	}

	function clearProblem(user: ListedUser) {
		void act(async () => {
			await clearDeliveryProblem(user.id, options);
			return `Cleared the mail problem for ${user.email}.`;
		});
	}

	/** The flag in words, with a readable date: never raw ISO. */
	const problemText = (u: ListedUser) =>
		u.undeliverable ? `${u.undeliverable.kind === 'bounce' ? 'Mail bounced' : 'Mail complaint'} on ${formatDateTime(u.undeliverable.at)}` : '';

	const addedBy = (u: ListedUser) => (u.addedBy === 'operator' ? 'the operator' : u.addedBy);
</script>

<svelte:head>
	<title>Users: Pitman</title>
	<meta name="description" content="Who can sign in to Pitman, who is an admin, and the recent changes." />
</svelte:head>

<AppBar />

<main id="main" tabindex="-1" class="page">
	<p class="back"><a href="/">Back to Pitman</a></p>
	<h1>Users</h1>

	{#if session.status === 'in' && !session.isAdmin}
		<p class="warn">Only an admin can see and change who can sign in. Ask an admin to add or remove someone.</p>
	{:else if session.status === 'error'}
		<p class="warn">Pitman could not check your sign-in. Reload the page to try again.</p>
	{:else if refused}
		<p class="warn">{refused}</p>
	{:else if !loaded}
		<p class="note">Loading the list…</p>
	{:else}
		<p>Only the addresses below can sign in. Pitman keeps little else about them (a bounce or spam report, until cleared): see <a href="/privacy">Privacy</a>.</p>

		<section class="card" aria-labelledby="add-h">
			<h2 id="add-h">Add someone</h2>
			<form onsubmit={add} novalidate>
				<label for="new-user-email">Email address</label>
				<input id="new-user-email" type="email" autocomplete="off" spellcheck="false" bind:value={newEmail} />
				<label class="tick"><input type="checkbox" bind:checked={newAdmin} /> Admin: can add and remove users</label>
				<div class="actions">
					<button type="submit" class="primary" disabled={busy}>Add</button>
				</div>
			</form>
		</section>

		<!-- Always in the page, so what an action did, or why it was refused, is heard. -->
		<p class="status" role="status">{status}</p>
		<p class="error" role="alert">{error ?? ''}</p>

		<section class="card" aria-labelledby="list-h">
			<h2 id="list-h">Who can sign in</h2>
			<div class="scroll">
				<table class="wide">
					<caption class="sr">Users, their role and who added them</caption>
					<thead>
						<tr><th scope="col">Address</th><th scope="col">Role</th><th scope="col">Added</th><th scope="col">Actions</th></tr>
					</thead>
					<tbody>
						{#each users as user (user.id)}
							<tr>
								<th scope="row">
									{user.email}{#if user.id === session.user?.id}<span class="you"> (you)</span>{/if}
									{#if user.undeliverable}
										<!-- A hard bounce or a spam complaint (SES): codes may not reach them until the address is fixed. -->
										<span class="problem">
											<span class="badge" title={user.undeliverable.kind === 'bounce' ? 'Sign-in codes to this address bounced' : 'This address reported Pitman’s mail as spam'}>{problemText(user)}</span>
											<button type="button" onclick={() => clearProblem(user)} disabled={busy}>
												Clear<span class="sr"> the mail problem for {user.email}</span>
											</button>
										</span>
									{/if}
								</th>
								<td>{user.isAdmin ? 'Admin' : 'User'}</td>
								<td>{formatDateTime(user.addedAt)} by {addedBy(user)}</td>
								<td>
									{#if confirming === user.id}
										<span class="confirm">
											<span>Remove {user.email}?</span>
											<button type="button" id={`keep-${user.id}`} onclick={() => keep(user)}>Keep</button>
											<button type="button" class="danger" onclick={() => remove(user)}>Remove</button>
										</span>
									{:else}
										<span class="row-actions">
											<button type="button" onclick={() => toggleAdmin(user)} disabled={busy}>
												{user.isAdmin ? 'Remove admin' : 'Make admin'}<span class="sr"> for {user.email}</span>
											</button>
											<button type="button" id={`remove-${user.id}`} onclick={() => askRemove(user)} disabled={busy}>
												Remove<span class="sr"> {user.email}</span>
											</button>
										</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		<section class="card" aria-labelledby="audit-h">
			<h2 id="audit-h">Recent changes and sign-ins</h2>
			{#if auditError}
				<p class="warn">{auditError}</p>
			{:else if audit.length === 0}
				<p class="note">Nothing recorded yet.</p>
			{:else}
				<p class="note">The latest {audit.length}, newest first, in your time zone. Rows are kept for about 24 months.</p>
				<div class="scroll">
					<table class="wide">
						<caption class="sr">Audit log</caption>
						<thead>
							<tr><th scope="col">When</th><th scope="col">What happened</th></tr>
						</thead>
						<tbody>
							{#each audit as row, i (i)}
								<tr>
									<td class="when"><time datetime={row.at}>{formatDateTime(row.at)}</time></td>
									<td>{actorText(row.actor)} {actionText(row)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	{/if}
</main>

<style>
	.page {
		max-width: 64rem;
		margin: 0 auto;
		padding: 1rem 1.25rem 3rem;
		display: grid;
		gap: 1rem;
		grid-template-columns: minmax(0, 1fr);
	}
	.page > * {
		margin: 0;
	}
	.back {
		font-size: var(--font-sm);
	}
	label {
		display: block;
		font-weight: 600;
		margin: 0.5rem 0 0.35rem;
	}
	label.tick {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		font-weight: 400;
		min-height: 1.75rem;
		margin-top: 0.75rem;
	}
	#new-user-email {
		width: min(100%, 28rem);
	}
	.wide {
		width: 100%;
		min-width: 36rem;
	}
	.wide tbody th {
		text-align: left;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.you {
		color: var(--text-muted);
		font-weight: 400;
	}
	.when {
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.row-actions,
	.confirm {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}
	.problem {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
		margin-top: 0.3rem;
		font-weight: 400;
	}
	.badge {
		font-size: var(--font-sm);
		color: var(--danger);
		border: 1px solid var(--danger);
		border-radius: 999px;
		padding: 0.05rem 0.55rem;
	}
	button.danger {
		border-color: var(--danger);
		color: var(--danger);
	}
	.status:empty,
	.error:empty {
		position: absolute;
	}
</style>
