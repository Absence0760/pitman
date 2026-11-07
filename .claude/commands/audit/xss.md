---
description: Audit the paths where file contents a user loads, upstream data-source strings and error text reach the DOM for XSS — Svelte `{@html}`, DOM HTML sinks, dynamic href/src, SVG, map popups — and confirm the strict CSP still backs them up
---

Find every place untrusted text is rendered in Pitman's frontend, and verify it's escaped (Svelte's default) or that nothing script-bearing can come through.

## Goal

Pitman has no CMS and no stored user content: the frontend is a static SvelteKit SPA, and a network is loaded, run and saved entirely in the browser. The untrusted text is therefore:

- **The contents of files a user loads**: a zip or folder holding a `.NET`, module files, `.RAN` rainfall, observed and defined-flow files, the `pitman.json` sidecar (`frontend/src/lib/network/`, read by `packages/wrsm/src/io/`), an uploaded GeoJSON area (`frontend/src/lib/extend/area.ts`). A network can come from a colleague or a download, so file names, module names, comments and sidecar fields are attacker-controlled. They surface in issue lists (`frontend/src/lib/network/IssueList.svelte`), tables, chart labels, map labels and download file names.
- **Strings from the data API**: quaternary names and credits, Cape Farm Mapper layer attributes (crop and dam fields, `frontend/src/lib/landuse/cfm/`), provenance labels, and `{ error }` text from the backend.
- **Sign-in and admin text**: addresses and audit-log rows on the Users page (`frontend/src/routes/users/+page.svelte`, `frontend/src/lib/auth/audit.ts`), and the `next` parameter on the sign-in page (`frontend/src/lib/auth/next.ts`).

Svelte's `{value}` escapes all of these. The risk is a sink that doesn't, and a CSP that would no longer catch it.

## What to check

1. **`{@html}` and DOM HTML sinks.** Grep `frontend/src/` for `{@html`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `setHTMLUnsafe` and MapLibre's `setHTML` (popups in `frontend/src/lib/map/`). None exist today; any new one fed by the sources above, unsanitised, is High. Static, build-time strings (`frontend/src/routes/methods/content.ts`) are fine.
2. **Dynamic `href` / `src`.** Grep for `href={` and `src={`. Today they are in-page anchors, `mailto:` built from constants, and the methods page's source links from `content.ts`. A value built from file contents, an API answer or a query parameter must reject `javascript:` and `data:` schemes. The sign-in redirect follows `next` only to a path on this site, checked on the resolved path (`next.test.ts`); confirm that still holds.
3. **Downloads.** Blob URLs from `URL.createObjectURL` (`frontend/src/lib/network/download.ts`, `frontend/src/lib/results/Results.svelte`) carry a MIME type: it must stay a non-HTML type (zip, text, CSV) so a crafted file name or content can't open as a same-origin HTML document. The file name comes from the network; confirm it is only used as `download`, never in markup as HTML.
4. **SVG.** No user SVG is rendered. If a feature ever accepts one (a boundary or diagram), it must load through `<img>` or be parsed to data, never inlined.
5. **Chart and map labels.** uPlot and MapLibre draw on canvas (safe), but uPlot's legend and any tooltip built as HTML strings are DOM sinks; trace module and series names into them.
6. **Error text.** Backend errors reach the UI as `{ error }` strings rendered as text. Confirm they stay text, and that the backend never echoes an upstream's raw error or a request value into them (`backend/src/http/errors.ts`, `backend/src/http/logError.ts`).
7. **The CSP still backs this up.** `infra/csp.json` (read by `infra/security_headers.tf`) gives `default-src 'self'`, no `'unsafe-eval'`, styles only by hash, `object-src 'none'`, `base-uri 'none'`; `script-src` carries `'unsafe-inline'` only because SvelteKit's meta-tag CSP narrows it to the build's hash, which `infra/scripts/check-csp.mjs` enforces at deploy. Any new source, a removed directive or a build without the meta CSP is a finding; `frontend/e2e/map.spec.ts` fails on a violation.
8. **Mail.** The sign-in email is plain text with nothing in it but the code (`signInMessage` in `backend/src/auth/mail.ts`). An HTML body, or any user-supplied value in the message, is a finding.

## Report

- **High**: untrusted text reaches the DOM as HTML or as a script-capable URL. Give the payload that proves it (a module named `<img src=x onerror=alert(1)>` in a `.NET`, say) and the file that carries it.
- **Medium**: escaping holds but a borderline scheme passes a URL check, a download could be served as HTML, or the CSP was loosened.
- **Low**: correct today, but a helper makes a future sink easy (a function that returns markup sometimes and text other times).

For each: file:line, the source of the text, the rendering site, the fix. End with a **clean** list of the sources and sinks you traced and found safe.

## Delegate to

Use the `repo-security-auditor` agent: `"Audit XSS: untrusted text from loaded network files, GeoJSON areas, data-API answers and auth/admin text reaching the DOM in frontend/src/ ({@html}, HTML sinks, href/src, downloads, SVG, chart and map labels), and the CSP in infra/csp.json."`

Read-only. Report findings; don't patch without confirmation.
