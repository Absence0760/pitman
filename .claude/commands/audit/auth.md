---
description: Sweep every backend route for session gating and admin checks — the requireSession gate, the PUBLIC allowlist, admin-only routes, fail-closed config
---

Audit sign-in gating and admin authorization across the backend API.

## Goal

Pitman's API has one gate: `requireSession` (`backend/src/auth/middleware.ts`),
registered once in `createApp` (`backend/src/app.ts`) before every data route,
so a route added below it is gated by default. Only `/health` and the three
sign-in routes answer without a session. Sign-in, sessions and user
management come from auth-kit (CLAUDE.md project rule 7). There are no
tenants: every signed-in user sees the same data; admins alone manage users
and read the audit log. A route registered above the gate, or an admin route
that doesn't check the role, is the bug class to find.

## What to check

1. **Registration order.** Read `createApp`. Every route registered before
   `app.use('*', requireSession(auth))` must be on the `PUBLIC` set in
   `backend/src/auth/routes.test.ts` (`GET /health`, `POST /auth/code`,
   `/auth/verify`, `/auth/logout`) with a reason. A sub-app mounted with
   `app.route` above the gate exposes all its handlers.
2. **The enumeration test.** `backend/src/auth/routes.test.ts` walks
   `app.routes` and expects 401 on every non-public one, with no session and
   with a bad one. Confirm it still covers every route (new methods,
   parameterised paths) and that no route was added to `PUBLIC` without a
   reason.
3. **Admin routes.** `/users*` and `/audit` (`backend/src/auth/routes.ts`)
   answer 403 to a non-admin, enforced on the server by auth-kit; nobody
   removes or demotes themself; the last admin can't go. Confirm the
   frontend's hiding of **Users** isn't the only check.
4. **Session checks.** The cookie (`backend/src/auth/cookies.ts`): `__Host-`
   prefix, `Secure`, `HttpOnly`, `SameSite=Strict`; re-checked against the
   user record and revocations on every request, so a removal bites at once.
5. **Fail closed.** On Lambda, a missing or weak key, a missing table, the
   memory store, a non-SES mail transport or the dev cookie leaves sign-in
   unconfigured and every gated route 503 (`backend/src/auth/config.ts`).
   An unset CloudFront shared secret is 503 on everything (`backend/src/app.ts`).
6. **Enumeration and timing.** `POST /auth/code` answers 202 with the same
   body for listed and unlisted addresses, inside the latency floor
   (`backend/src/auth/runtime.ts`), and both do the same work: one sealed,
   same-size message on the mail queue (a decoy for an unlisted address,
   `backend/src/auth/mailQueue.ts`), never a send inside the request (#30).
   A path that sends mail or skips the enqueue for one kind of address is
   High. Nothing in a response, a log or a queued body says whether an
   address is listed.
7. **Request checks.** CORS without credentials, `csrf()`,
   `sameOriginWrites` (`backend/src/http/sameOrigin.ts`), JSON-only, the
   per-instance auth limit (`RATE_LIMITS.auth`) and the WAF's auth rule
   (`infra/waf.tf`).
8. **Frontend.** The sign-in gate in `frontend/src/routes/+layout.svelte` is a
   convenience; every API client goes through `sessionFetch`
   (`frontend/src/lib/auth/unauthorized.ts`), and `next` is followed only to
   a path on this site (`frontend/src/lib/auth/next.ts`).

## Report

- **Critical**: a data or admin route answers without a session; a non-admin can manage users or read the audit log.
- **High**: the enumeration test no longer covers a route; a config error leaves the gate open instead of 503.
- **Medium**: a public route without a stated reason; a response or log that reveals whether an address is listed.
- **Low**: a client-side-only check duplicating a server one without a comment.

For each: file:line, the concrete fix, the worst-case blast radius. A flaw in auth-kit itself is fixed there and taken by tag; say so.

## Delegate to

Use the `repo-security-auditor` agent: `"Audit area: auth. Sweep session gating and admin authorization across the backend API."`

Read-only. Findings only.
