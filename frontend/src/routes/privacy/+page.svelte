<!--
	The privacy notice (POPIA, issue #28 P6). Public and prerendered, like
	Methods. The responsible party's name and contact address come from
	lib/privacy/contact.ts and nowhere else. The facts here follow the design
	in docs/decisions.md (A-AUTH-1 … 11): change them together. Rewrite it
	before data_outside_south_africa is ever set (A-AUTH-6).
-->
<script lang="ts">
	import { PRIVACY_CONTACT } from '#lib/privacy/contact.js';
	import AppBar from '#lib/shell/AppBar.svelte';

	const UPDATED = '7 November 2026';
	const REGULATOR = {
		site: 'https://inforegulator.org.za',
		complaints: 'POPIAComplaints@inforegulator.org.za',
		enquiries: 'enquiries@inforegulator.org.za',
		phone: '010 023 5200'
	};
</script>

<svelte:head>
	<title>Privacy: what Pitman keeps about you</title>
	<meta name="description" content="What personal information Pitman keeps, why, where, for how long, and your rights under POPIA." />
</svelte:head>

<AppBar />

<main id="main" tabindex="-1" class="page">
	<p class="back"><a href="/">Back to Pitman</a></p>
	<h1>Privacy</h1>
	<p class="lede">
		Pitman keeps as little about you as it can: your email address and a record of sign-ins and changes to the user list. Your network files never leave
		your browser.
	</p>
	<p class="fine">Last updated {UPDATED}. This notice is given under the Protection of Personal Information Act, 2013 (POPIA).</p>

	<section aria-labelledby="who">
		<h2 id="who">Who is responsible</h2>
		<p>
			The responsible party for the personal information below is <strong>{PRIVACY_CONTACT.name}</strong>, who runs Pitman as an individual.
		</p>
		{#if PRIVACY_CONTACT.email}
			<p>Contact for anything in this notice: <a href={`mailto:${PRIVACY_CONTACT.email}`}>{PRIVACY_CONTACT.email}</a>.</p>
		{:else}
			<p>A contact address for privacy requests is being set up and will be published here. Until then, ask the admin who added you.</p>
		{/if}
	</section>

	<section aria-labelledby="what">
		<h2 id="what">What is kept</h2>
		<ul>
			<li><strong>Your email address</strong>, whether you are an admin, who added you and when.</li>
			<li>
				<strong>An audit record</strong> of each change to the user list (who added, removed or changed whom, and when) and of each sign-in, successful or
				not. A failed sign-in by an address that isn’t on the list is recorded without that address.
			</li>
			<li>
				<strong>Whether mail to you bounced or was reported as spam</strong>, and when, as Amazon SES reports it, until an admin clears it: so an admin
				knows a sign-in code may not reach you. The record of it goes in the audit record above.
			</li>
			<li><strong>Short-lived sign-in items:</strong> the code emailed to you (kept only as a one-way hash) and counts that limit how often codes can be sent.</li>
			<li>
				<strong>Your IP address, briefly,</strong> to limit how many requests one address can make. It is held in memory by the web firewall and the server
				while it counts, and is not written to logs or to the user list.
			</li>
			<li><strong>One cookie</strong>, which keeps you signed in for up to 7 days. Pitman sets no other cookies and uses no analytics or tracking.</li>
		</ul>
	</section>

	<section aria-labelledby="why">
		<h2 id="why">Why</h2>
		<p>
			To control who can use Pitman. Its data services serve licensed and permission-bound data (catchment boundaries, rainfall and land-use sources), so
			only people an admin has added may use them. Your address is how you sign in; the audit record shows who changed what, and lets misuse be traced.
			Nothing is used for marketing or shared for anyone else’s purposes.
		</p>
	</section>

	<section aria-labelledby="where">
		<h2 id="where">Where</h2>
		<p>
			Everything above is stored by Amazon Web Services in its Cape Town region (af-south-1), in South Africa, and sign-in emails are sent from there.
			Requests to Pitman pass through Amazon CloudFront and AWS WAF, which run worldwide, so a request (including your IP address and the session cookie) may
			be handled outside South Africa on its way to Cape Town. AWS processes this on Pitman’s behalf.
		</p>
		<p>
			<strong>Your network files never leave your browser.</strong> Pitman reads, runs and saves them on your own machine; the working copy is kept in your
			browser’s storage. When you use a data service, Pitman sends only the outline of an area or a box, never a network file.
		</p>
	</section>

	<section aria-labelledby="how-long">
		<h2 id="how-long">How long</h2>
		<dl class="register">
			<div><dt>Your address and role</dt><dd>Until an admin removes you.</dd></div>
			<div>
				<dt>Audit records</dt>
				<dd>About 24 months. They are deleted automatically once they expire, usually within a few days of it.</dd>
			</div>
			<div><dt>Sign-in codes and send limits</dt><dd>Minutes to a day, then deleted automatically, usually within a few days.</dd></div>
			<div><dt>Server logs</dt><dd>30 days. They carry an opaque user number and what happened, never your address, a code or your IP address.</dd></div>
			<div>
				<dt>Backups</dt>
				<dd>Anything deleted can still be restored for 35 days from the database’s point-in-time recovery, after which it is gone for good.</dd>
			</div>
		</dl>
	</section>

	<section aria-labelledby="rights">
		<h2 id="rights">Your rights</h2>
		<p>Under POPIA you may ask:</p>
		<ul>
			<li>whether Pitman holds personal information about you, and for a copy of it (access);</li>
			<li>for it to be corrected, or deleted, when it is wrong, out of date or no longer needed;</li>
			<li>for it not to be processed, by objecting on reasonable grounds.</li>
		</ul>
		<p>
			{#if PRIVACY_CONTACT.email}
				To ask, email <a href={`mailto:${PRIVACY_CONTACT.email}`}>{PRIVACY_CONTACT.email}</a> from the address your request is about.
			{:else}
				To ask, write to the admin who added you, from the address your request is about.
			{/if}
			To make sure it is you, we will ask you to reply from that address, and we answer only to it. If you act for someone else, send written proof
			of your authority to act for them. You may also use the Information Regulator’s PAIA Form 2.
		</p>
		<p>
			A request for access is answered free of charge within 30 days of receiving it (or, if we cannot manage that, by a later date you agree to, no
			more than 30 days later). You get a copy of everything Pitman keeps under your address: your user record, your sign-in limits and any live
			code’s expiry, each audit-record entry that names you, and whether Amazon SES has stopped mail to you. You are also told who has had access to
			it. Other people’s addresses in those entries are withheld.
		</p>
		<p>
			Deleting your address removes you from the user list and replaces it in the audit record, so you can no longer sign in. It is complete after the
			35 days of backups above.
		</p>
		<p>
			If you are unhappy with how your information is handled, you may complain to the <strong>Information Regulator</strong> (South Africa): complete
			POPIA Form 5 and email it to <a href={`mailto:${REGULATOR.complaints}`}>{REGULATOR.complaints}</a>. General enquiries:
			<a href={`mailto:${REGULATOR.enquiries}`}>{REGULATOR.enquiries}</a> or {REGULATOR.phone}. Website: <a href={REGULATOR.site}>inforegulator.org.za</a>.
		</p>
	</section>
</main>

<style>
	.page {
		max-width: 75ch;
		margin: 0 auto;
		padding: 1rem 1.25rem 3rem;
		line-height: 1.6;
	}
	.back {
		margin: 0.5rem 0;
		font-size: var(--font-sm);
	}
	h1 {
		margin: 0.25rem 0 0.5rem;
	}
	.lede {
		font-size: 1.05rem;
	}
	section {
		margin-top: 2rem;
	}
	ul {
		padding-left: 1.25rem;
	}
	li + li {
		margin-top: 0.4rem;
	}
	.register {
		display: grid;
		gap: 0.75rem;
		margin: 0.75rem 0;
	}
	.register div {
		border-left: 3px solid var(--border-strong);
		padding-left: 0.75rem;
	}
	.register dt {
		font-weight: 600;
	}
	.register dd {
		margin: 0;
	}
	.fine {
		font-size: var(--font-sm);
		color: var(--text-muted);
	}
	a {
		overflow-wrap: anywhere;
	}
</style>
