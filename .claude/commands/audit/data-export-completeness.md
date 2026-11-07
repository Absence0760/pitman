---
description: Verify a POPIA s23 access request can be answered completely — every item in the user table, audit log and mail flags that names a person, and a documented procedure to gather it
---

Audit whether Pitman can answer a request for access to a person's information
(POPIA s23) completely and without leaking anyone else's.

## Goal

Pitman has no self-serve "download my data". An access request reaches the
operator, who must gather everything the system holds about the address. The
risk is silent drift: a new item or attribute naming a person is added, the
procedure (if any) doesn't know about it, and the answer comes back partial.

## What to check

1. **Inventory.** From the store code (`backend/src/auth/store.ts`, auth-kit's
   item shapes it wires, `infra/users.tf`), list every item kind and attribute
   that holds an address, an address HMAC or a user id: the user item, the
   address index, codes, locks and send counters, revocations and the
   watermark, audit rows (as actor, target and "added by"), the
   delivery-problem flag.
2. **Reachability.** For each, how would the operator find it for one
   address: a key lookup, an index, or a scan the Lambda isn't allowed to run?
   Name any item that can only be found by a scan.
3. **Procedure.** Is the access procedure written down (in `docs/security.md`
   next to § Erasure, or an operator script beside `backend/scripts/erase-address.ts`)?
   If not, that is the headline finding; describe what it would have to do.
4. **Other people's data.** Audit rows name two people (actor and target).
   What would have to be redacted before sending one to the requester?
5. **Outside the table.** SES's suppression list entry, the bounce queue and
   its DLQ (`infra/ses.tf`), CloudWatch logs (should hold no address,
   `backend/src/__tests__/logGuard.ts`). Note what the answer must mention.
6. **What is not held.** Network files and the working copy stay in the
   user's browser; the data API receives only area outlines. The answer can
   say so; confirm the code still makes it true (`frontend/src/lib/network/storage.ts`).
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
