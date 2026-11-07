---
description: Map every outbound personal-data hop into a sub-processor list ready for the privacy notice
---

Audit every outbound flow from Pitman and what personal data, if any, it
carries. The output is the sub-processor list behind the privacy notice's
"Where" section (`frontend/src/routes/privacy/+page.svelte`).

## Goal

The Information Regulator's first question in an incident, and a user's
first question in the notice, is "who gets my data?". Pitman's answer today is
"AWS only". This audit checks the code still makes that true.

## What to check

1. **Inventory.** Grep `backend/src/` and `frontend/src/` for `fetch(`, AWS
   SDK clients (`@aws-sdk/*`), `nodemailer` and hard-coded `https://` hosts.
   Expect: DynamoDB (the user table), SES (sign-in mail, `backend/src/auth/mail.ts`),
   S3 (the CHIRPS mirror and MAP grid, read cross-account from IC-WBT's
   buckets), the DEM, and Cape Farm Mapper's ArcGIS layers
   (`backend/src/cfm/arcgis.ts`). In the browser: only the site's own origin
   (`infra/csp.json`, `connect-src 'self'`).
2. **Per flow.** What leaves (an address, a code, an IP, an area outline)?
   From where (browser, Lambda)? To which region? Under which terms (AWS's
   DPA; Cape Farm Mapper's terms)?
3. **Area outlines.** The data API and Cape Farm Mapper receive geometry
   only, never a network file or a user id. Confirm nothing personal (the
   address, the session) is forwarded upstream.
4. **CloudFront and the WAF.** Every request passes through them worldwide
   (IP, cookie); sampled requests are off. Confirm in `infra/waf.tf` and that
   the notice discloses it.
5. **Mail.** SES in af-south-1; bounces and complaints come back through SNS
   and SQS (`infra/ses.tf`). Local dev uses Mailpit or the console, never a
   real service.
6. **Sub-sub-processors.** AWS's own; the notice should point to AWS rather
   than enumerate them.

## Report

Output two artefacts:

### (A) Sub-processor table

| Provider | Data | Region | Purpose | Terms | Notice line |
|---|---|---|---|---|---|

### (B) Findings

- **Critical**: a flow carrying personal data to a provider the notice doesn't name.
- **High**: personal data forwarded upstream to a data source (Cape Farm Mapper, IC-WBT's buckets).
- **Medium**: a region or retention the notice gets wrong.
- **Low**: an undocumented sub-sub-processor chain.

End with a **clean** section: outbound endpoints where you confirmed no personal data leaves.

## Delegate to

Use the `compliance-auditor` agent: `"Audit area: third-party-data-flows."`

Read-only. Output the table and findings. Legal readings of a provider's terms go to `za-legal-researcher`.
