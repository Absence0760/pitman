---
description: Verify POPIA erasure — the Users-page removal plus admin:erase leave no item, audit row, SES entry or log that still names the person
---

Audit the erasure procedure (`docs/security.md` § Erasure) against the code.
When a person's address is erased, nothing should still name them once the
35 days of point-in-time recovery have passed.

## Goal

POPIA lets a person ask for their information to be deleted (s24). Pitman's
path has three steps: an admin removes the user (`DELETE /users/:id`), the
operator runs `pnpm admin:erase` (`backend/scripts/erase-address.ts`), which
pseudonymises the audit log and clears the SES suppression entry, and
point-in-time recovery ages out. The risk is an item or copy the procedure
doesn't reach.

## What to check

1. **Removal.** Read `DELETE /users/:id` in `backend/src/auth/routes.ts` and
   the auth-kit call behind it. Which items does it delete (user, address,
   code, lock)? Which does it leave (send counters, revocations, audit rows)?
2. **Erasure script.** Read `backend/scripts/erase-address.ts` and
   `backend/scripts/operator.ts`. Does it reach every audit row as actor and
   target, every other user's "added by", the code and lock items? Does it
   refuse cleanly for the last admin, and say "Not finished" when rows keep
   appearing? Is it covered by `backend/scripts/operator.test.ts`?
3. **SES.** Is the account-level suppression entry removed with the address
   the script already read (never typed into a shell)? Does the Lambda lack
   `ses:DeleteSuppressedDestination` (`infra/ses.tf`), as documented?
4. **Copies outside the table.** The bounce queue and its DLQ (messages
   carry the recipient; check their retention in `infra/ses.tf`), CloudWatch
   logs (should hold no address, `backend/src/__tests__/logGuard.ts`), the
   operator's shell history (the script reads stdin, never argv), Terraform
   state (should hold none).
5. **Backups.** Point-in-time recovery (`infra/users.tf`): the 35 days the
   notice states.
6. **Re-adding.** If the address is added again later, it starts fresh; an
   `erased:` pseudonym never maps back to it.
7. **Notice.** `frontend/src/routes/privacy/+page.svelte` describes deletion
   truthfully.

## Report

- **Critical**: an item or copy that still holds the address after the full procedure.
- **High**: a step that can fail silently, or a copy kept longer than the notice says.
- **Medium**: an untested step, or a step that needs the address typed into a shell.
- **Low**: wording drift between the procedure, the script's messages and the notice.

For each: the item or copy, and where the procedure or code would change.

End with a **clean** list of items and copies that are fully covered.

## Delegate to

Use the `compliance-auditor` agent: `"Audit area: account-deletion-completeness."`

Read-only. Findings only.
