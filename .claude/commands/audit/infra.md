---
description: Audit the Terraform stack under infra/ — IAM least-privilege, cross-account grants, encryption, headers, drift hygiene, cost + DR guardrails
---

Audit the Terraform at `infra/` against the architecture documented in `docs/architecture.md`, `docs/deployment.md` and `docs/security.md` § Infrastructure.

## Goal

Pitman's blast radius runs through this stack: a permissive deploy policy makes the account writable from CI; a bucket policy or cross-account grant broader than its prefix exposes or bills data it shouldn't; a header policy that loosens the CSP undoes the XSS story; a missing `ignore_changes` makes Terraform fight the deploy workflow. Catch the high-cost mistakes before `terraform apply` reaches the account.

## Files in scope (the whole `infra/` directory)

- `main.tf` — providers (primary region and `us_east_1`), the partial S3 backend, `default_tags`
- `variables.tf` — inputs and their validation (region and residency, Lambda bounds, WAF limits, budget, alarms)
- `outputs.tf` — the values the GitHub repo variables are set from
- `s3_cloudfront.tf` — site bucket + OAC + ACM cert + CloudFront (the `/api/*` and `/tiles/*` behaviours, the shared-secret custom header) + Route 53
- `security_headers.tf` + `csp.json` — the response-headers policies (site and API), the CSP read from `csp.json`
- `functions/spa_rewrite.js`, `functions/api_strip_prefix.js` — the CloudFront functions
- `waf.tf` — the web ACL (us-east-1) and its per-IP rules
- `lambda.tf` — the API function, its role, log group, Function URL and the cross-account read grants
- `users.tf` — the DynamoDB user table, the Lambda's grant on it, the auth keys
- `ses.tf` — the SES identity, DKIM/MAIL FROM/DMARC records, the send grant, the bounce/complaint SNS → SQS queue and DLQ
- `alarms.tf` — SNS topics, the budget and every alarm
- `oidc.tf` — the deploy policy attached to the estate bootstrap's `pitman-deploy` role
- `tests/*.tftest.hcl` — plan-only tests that pin the bounds above
- `backend.config.example`, `terraform.tfvars.example` — committed templates; the real ones are gitignored

## What to check

1. **State backend** (`main.tf`). Partial `backend "s3"` with `encrypt = true` and `use_lockfile = true` (S3-native locking; no DynamoDB lock table). The bucket comes from the estate bootstrap and `infra/backend.config` (gitignored). `required_version` and `required_providers` pinned with `~>`; `.terraform.lock.hcl` committed.

2. **Deploy role** (`oidc.tf`). The OIDC provider and the role's trust policy are owned by the estate bootstrap (`new-project-account.sh`), which pins `:sub` to `repo:Absence0760/pitman:environment:production`; this file only looks the role up and attaches a policy. Check the policy is per-resource: `s3:PutObject`/`DeleteObject`/`ListBucket` on the site bucket only, `cloudfront:CreateInvalidation` on this distribution only, `lambda:UpdateFunctionCode` (and reads) on this function only. No `iam:*`, `sts:AssumeRole`, `*` resources or configuration changes.

3. **Site bucket** (`s3_cloudfront.tf`). Public access block with all four flags; SSE; ownership `BucketOwnerEnforced` (no ACLs); the bucket policy grants `cloudfront.amazonaws.com` only, conditioned on `AWS:SourceArn` = this distribution; TLS enforced.

4. **CloudFront** (`s3_cloudfront.tf`, `security_headers.tf`, `csp.json`).
   - `redirect-to-https`; `minimum_protocol_version` TLSv1.2_2021 or stricter; OAC on the S3 origin.
   - A response-headers policy on every behaviour: HSTS (2 years), nosniff, `DENY` framing, COOP, Permissions-Policy, and the strict CSP. The site CSP has no `'unsafe-eval'`, no style `'unsafe-inline'`, `connect-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`; the API's is `default-src 'none'`. `infra/tests/stack.tftest.hcl` (`site_csp_is_strict`) and `infra/scripts/check-csp.mjs` pin it; a new source needs its reason in `docs/security.md`.
   - The `/api/*` origin sends `X-CloudFront-Shared-Secret` (a `random_password`) and strips `/api` (`functions/api_strip_prefix.js`); `origin_read_timeout` equals the Lambda timeout.
   - Every prerendered page has a `PAGES` entry in `functions/spa_rewrite.js` (tested by `infra/scripts/cloudfront-functions.test.mjs`).
   - `price_class` is `PriceClass_200` (or `_100`), not `_All`.

5. **WAF** (`waf.tf`). Attached to the distribution; per-IP rate rules on `/api/auth/*` (except `/api/auth/me`), `/api/*` and every path, with path normalisation before matching; sampled requests off on the ACL and every rule (they would keep the session cookie outside af-south-1, `docs/security.md` § Infrastructure); no managed rule groups (their 8 KB body limit breaks polygon POSTs).

6. **Lambda** (`lambda.tf`).
   - `runtime = "nodejs24.x"`, `architectures = ["arm64"]`; memory, timeout and `reserved_concurrent_executions` from `variables.tf`, whose validations reject an unreserved function, a timeout outside 25–30 s and unbounded log retention (pinned by `infra/tests/stack.tftest.hcl`).
   - The role may write only its own log group, the user table's six auth-kit actions, `ses:SendEmail` on the identity and configuration set, receive/delete on the mail-events queue, and the cross-account reads. Never `Scan`, `Batch*` or `ses:DeleteSuppressedDestination`.
   - The Function URL is `NONE` auth by design; the shared secret in the app is the gate.
   - `lifecycle.ignore_changes` is minimal (the code the deploy workflow replaces), nothing that hides configuration drift.

7. **Cross-account grants** (`lambda.tf`, `docs/data.md` § Cross-account access). `GetObject` on the CHIRPS mirror's `rnl/*` (and the root `zarr.json` when enabled) and one MAP-grid key; `ListBucket` only under `rnl/`; every statement conditioned on `s3:ResourceAccount` = IC-WBT's account. No KMS, no other prefix. With no IC-WBT account configured, nothing is granted (`defaults_grant_nothing_cross_account`).

8. **User table** (`users.tf`). On-demand billing, point-in-time recovery on (the erasure window), `deletion_protection_enabled`, the `ttl` attribute on (auth-kit's expiring items; expiry is still checked in code), encryption at rest (DynamoDB's default AWS-owned key unless a reason to change it is documented); region refused outside af-south-1 unless `data_outside_south_africa = true`. The auth keys are `random_password` values, marked `sensitive`.

9. **SES** (`ses.tf`). DKIM, a custom MAIL FROM with SPF, DMARC; a configuration set routing bounces and complaints to SNS → SQS with a DLQ; queue policies scoped to the topic and the Lambda.

10. **Budget and alarms** (`alarms.tf`). The monthly budget with forecasted and actual notifications, credits and refunds excluded (skipped only while `budget_monthly_usd = 0` with `no_budget_acknowledged = true`); alarms on Lambda errors, throttles, invocations, duration, CloudFront requests, bytes and 5xx, WAF blocks, SES rates, the user table, the mail-events DLQ and the auth log filters; both SNS topics subscribed to `alert_email`.

11. **Secrets.** Production secrets live in `../infra-secrets/pitman/` (SOPS + KMS), never in this repo; `infra/terraform.tfvars` and `infra/backend.config` are gitignored; no `output` exposes a sensitive value without `sensitive = true`. The SOPS KMS key is provisioned by `infra-secrets`, not here.

12. **Tagging.** `default_tags` on both providers carry the project tags (`local.tags`).

13. **Tests.** `terraform -chdir=infra test` (run by `.github/workflows/terraform.yml`) covers the bounds above; a behaviour the audit relies on with no `run` block pinning it is a Low.

## Report

- **Critical**: the deploy policy with `*` resources or IAM actions; a public site bucket or one readable without OAC; a cross-account grant broader than its prefix or missing the `s3:ResourceAccount` condition; a secret committed.
- **High**: the CSP loosened (`'unsafe-eval'`, a new external source, style `'unsafe-inline'`); WAF detached; reserved concurrency removed; the Lambda role able to `Scan` the user table or delete SES suppressions; data placed outside af-south-1 without the flag.
- **Medium**: unbounded log retention; a missing header; a drift-prone `ignore_changes`; sampled requests on; CloudFront `PriceClass_All`.
- **Low**: a loose version pin; an undocumented `lifecycle` choice; a bound with no `tftest` assertion.

For each finding: file:line and the concrete change. Don't apply fixes without explicit confirmation.

## Useful starting points

- `infra/README.md` — the map of the stack and the apply order
- `infra/oidc.tf` — the highest blast-radius file
- `infra/lambda.tf` — the function, its grants and the cross-account reads
- `infra/s3_cloudfront.tf`, `infra/security_headers.tf`, `infra/csp.json` — hosting, CDN and headers
- `infra/tests/stack.tftest.hcl`, `infra/tests/auth.tftest.hcl` — what is already pinned
- `docs/deployment.md`, `docs/security.md` § Infrastructure, `docs/data.md` § Cross-account access — what the stack is supposed to be; a delta against them IS a finding

## Delegate to

The `infra-auditor` agent with `"Audit area: all"` (or `iam`, `cross-account`, `data`, `observability`) as the prompt's first sentence, plus this file's checklist.

Read-only. Findings only. Don't run `terraform plan` with real credentials or `terraform apply`: those reach AWS. `terraform -chdir=infra test` is plan-only with mocked providers and is fine.
