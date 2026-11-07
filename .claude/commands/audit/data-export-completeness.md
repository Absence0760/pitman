---
description: Verify a POPIA s23 access request can be answered completely — every item in the user table, audit log and mail flags that names a person, and a documented procedure to gather it
---

Audit whether Pitman can answer a request for access to a person's information
(POPIA s23) completely and without leaking anyone else's.

## Goal

Pitman has no self-serve "download my data". An access request reaches the
operator, who follows `docs/security.md` § Access requests and runs
`pnpm admin:export` (`backend/scripts/export-address.ts`), which writes one
section per kind in auth-kit's `PERSONAL_RECORDS` (its `exportAddress`,
v0.3.0) plus the SES suppression entry. The risk is silent drift: a new item
or attribute naming a person is added, the export doesn't know about it, and
the answer comes back partial. auth-kit's contract suite guards one direction
(anything its `eraseAddress` touches, its export returns), and
`backend/scripts/export-address.test.ts` checks every kind reaches the file;
this audit looks for what neither knows about.

## What to check

1. **Inventory.** From the store code (`backend/src/auth/store.ts`, auth-kit's
   item shapes it wires, `infra/users.tf`), list every item kind and attribute
   that holds an address, an address HMAC or a user id: the user item, the
   address index, codes, locks and send counters, revocations and the
   watermark, audit rows (as actor, target and "added by"), the
   delivery-problem flag.
2. **Reachability.** For each, does `export-address.ts` read it (a key
   lookup, the USER, AUDIT or `SESSIONS#<userId>` partition), and is it a
   section in auth-kit's `PERSONAL_RECORDS`? Name any item that can only be found by a scan, and
   any item kind the inventory found that the export has no section for
   (Critical). Audit rows count under every form the address takes: in
   clear, `unlisted:<hmac>` and `erased:<hmac>`.
3. **Procedure.** Does `docs/security.md` § Access requests still match the
   script (its prompts, the output path rule, the IAM it needs, the `export`
   audit row) and cover verification, the deadline, what to send and what to
   record? Is the auth-kit pin at a version whose contract suite still
   classifies every item erasure touches, rather than skipping unknown ones
   (auth-kit `test/contract.ts` § export)?
4. **Other people's data.** Audit rows name two people (actor and target),
   and the user item names who added them. Confirm the export withholds every
   address but the requester's (the export test checks the seeded case; look
   for any field it passes through unredacted).
5. **Outside the table.** SES's suppression list entry (the export reads
   it), the bounce queue and its DLQ (`infra/ses.tf`), CloudWatch logs (should
   hold no address, `backend/src/__tests__/logGuard.ts`). Confirm the
   procedure's manual checks for the DLQ and logs still name the right queue
   and log group.
6. **What is not held.** Network files and the working copy stay in the
   user's browser; the data API receives only area outlines. The export's
   `notHeld` list says so; confirm the code still makes each line true
   (`frontend/src/lib/network/storage.ts`, the log retention in `infra/`).
7. **Format.** The answer should be readable and complete: timestamps in UTC
   ISO 8601, roles and actions in words.

## Report

- **Critical**: an item naming the person that the procedure (or the obvious lookups) would miss entirely, or no way to find it without a scan.
- **High**: no documented procedure; or an answer that would include another person's address.
- **Medium**: an attribute or source (SES suppression, the DLQ) the procedure doesn't mention.
- **Low**: format or wording issues.

For each: the item kind and attribute, and where the procedure or code would change.

End with a **clean** list of items that are fully covered.

## Delegate to

Use the `compliance-auditor` agent: `"Audit area: data-export-completeness."`

Read-only. Findings only.
