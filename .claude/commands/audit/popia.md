---
description: Audit the privacy posture against POPIA (and GDPR if asked) — the personal-data record, notice, retention, residency and transfers, data-subject rights, breach procedure — via compliance-auditor
---

Check that Pitman still keeps only the personal information its record
describes (`docs/security.md` § Users and sign-in and § Erasure, and the
privacy notice `frontend/src/routes/privacy/+page.svelte`), for the periods it
states. The responsible party (the operator) and counsel own the legal calls;
this is the evidence they work from.

## Procedure

1. Spawn one **`compliance-auditor`** agent with the prompt `Audit area: popia.`
   It checks, with `file:line` evidence:
   - every kind of personal data the backend keeps (user items, stranger
     HMACs, codes, locks and send counters, revocations, audit rows, the
     delivery-problem flag, logs, backups) is in the notice, and nothing the
     notice promises is missing from the code;
   - the retention periods the notice states match the Terraform (TTL
     attributes and point-in-time recovery in `infra/users.tf`, log
     retention in `infra/lambda.tf`);
   - residency: the table and SES in af-south-1 (`infra/variables.tf`
     refuses another region unless `data_outside_south_africa` is set), and
     the passage through CloudFront and the WAF disclosed as a cross-border
     transfer (s72);
   - the rights section (access, correction, deletion, objection, the
     Regulator's contact) is honoured by a real path: the Users page and
     `docs/security.md` § Erasure, and a documented way to answer an access
     request;
   - the responsible party's name and contact are filled in
     (`frontend/src/lib/privacy/contact.ts`);
   - a breach procedure exists (`docs/security.md` § Incident playbook) and
     covers notifying the Information Regulator and the people affected (s22);
   - for GDPR only if the operator names it: the Art 13 and Art 27 extras.
2. Relay its report as is: findings most severe first, then Clean.

Legal readings end with "confirm with counsel". A question that needs a reasoned legal position goes to the `za-legal-researcher` agent.

## Delegate to

The `compliance-auditor` agent: `"Audit area: popia."`

Read-only. Don't apply fixes; offer them, one path-scoped commit per finding.

## When

After adding anything that stores, logs, mails or sends a person's data, and before a release.
