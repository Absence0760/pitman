---
description: Verify Pitman still sets only strictly necessary cookies and storage and loads no third-party script, so no consent banner is needed
---

Audit the web app's cookie, storage and third-party-load posture.

## Goal

Pitman's position is that it needs no consent banner: one strictly necessary
session cookie, the user's own working copy in IndexedDB, no analytics, no
tracking, no third-party scripts, fonts or images (the privacy notice,
`frontend/src/routes/privacy/+page.svelte`, says so). A finding is anything
that changes that, which would bring POPIA's consent rules (and, for EU
visitors, ePrivacy Art 5(3)) into play.

## What to check

1. **Cookies.** Every `Set-Cookie` the backend sends: only
   `__Host-pitman_session` (`backend/src/auth/cookies.ts`), `HttpOnly`,
   `Secure`, `SameSite=Strict`, 7 days. The dev-only `pitman_session` must
   stay refused on Lambda (`backend/src/auth/config.ts`).
2. **Browser storage.** Grep `frontend/src/` for `localStorage`,
   `sessionStorage`, `indexedDB` and `document.cookie`. The working copy
   (`frontend/src/lib/network/storage.ts`) holds the user's own network, set
   by their action. Anything else that identifies a person or a device, or is
   written on first visit, is a finding.
3. **Third-party loads.** `infra/csp.json` allows only `'self'`; confirm no
   `<script src>`, font, image, tile or `fetch` to another origin in
   `frontend/src/app.html`, `frontend/src/routes/+layout.svelte` or anywhere
   under `frontend/src/lib/` (the map's tiles and glyphs are same-origin
   under `/tiles/*`).
4. **The public pages.** `/sign-in`, `/privacy` and `/methods` load nothing
   beyond the site itself before anyone signs in.
5. **The notice.** Its cookie and storage statements match what you found.

## Report

- **Critical**: a third-party script or tracker that loads at all.
- **High**: a non-essential cookie or storage key, or a third-party origin added to the CSP.
- **Medium**: an essential one the notice doesn't describe.
- **Low**: wording drift.

For each: the file/line, what it stores or sends, and how to remove or disclose it.

End with a **clean** section listing what you confirmed.

## Delegate to

Use the `compliance-auditor` agent: `"Audit area: cookie-consent."`

Read-only. Findings only.
