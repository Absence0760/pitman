---
description: Verify spend safeguards across AWS (Lambda, CloudFront, WAF, SES, DynamoDB, the cross-account data reads) and Cape Farm Mapper — no single failure should produce a runaway bill
---

Audit every layer that bounds runaway spend. The realistic cost accidents for Pitman: a flood of costly data calls (`POST /delineate` reads hundreds of MB of DEM and runs up to 20 s; `GET /channels` routes a 3 × 3 window; `POST /chirps/monthly` and `/map-grid/*` read the CHIRPS mirror and a MAP grid cross-account), CloudFront egress on `/tiles/*`, a sign-in flood sending SES mail, a chatty Lambda with long log retention, and a fan-out to Cape Farm Mapper. Each should be capped by **at least one** independent ceiling, and none should run unbounded for hours before an alarm fires.

## Goal

Pitman's legitimate traffic is a handful of hydrologists. A finding is anything that lets the bill exceed the configured `budget_monthly_usd` by an order of magnitude before any alarm fires. There are no payments, no CMS and no third-party email service: AWS (including SES) is the whole bill, plus whatever Cape Farm Mapper's terms allow.

## What to check

### 1. Who can call the costly routes

- Every data route sits behind the session gate (`requireSession` in `backend/src/app.ts`): an anonymous flood gets 401 before any read. `backend/src/auth/routes.test.ts` proves it by enumerating `app.routes`.
- The Function URL answers only CloudFront: it is `AWS_IAM` behind the `lambda` OAC (`infra/s3_cloudfront.tf`, R4-I6), so a direct hit is refused by Lambda before it is invoked or billed; behind that, the shared-secret check in `backend/src/app.ts` (403 without it, 503 on Lambda when unset). The WAF can't be bypassed.

### 2. Per-instance and per-IP limits

- `RATE_LIMITS` in `backend/src/app.ts` (`backend/src/http/rateLimit.ts`): one limit per costly route (`chirps`, `mapGrid`, `delineate`, `channels`, `quaternaries`, `landUse`, `auth`). Each route that reads S3 or calls upstream is mounted with one; a new costly route without one is High.
- The limiter is per Lambda instance (in memory); the WAF (`infra/waf.tf`) is the cross-instance per-IP cap: `waf_api_rate_limit_per_ip` on `/api/*`, `auth_waf_rate_limit_per_ip` on `/api/auth/*` (except `/api/auth/me`), `waf_site_rate_limit_per_ip` on every path. Confirm the rules exist, match `docs/security.md` § Infrastructure, and that path normalisation runs before matching.
- Input caps: the body limit and the area/box limits (`backend/src/http/area.ts`, the CHIRPS cell cap, the delineation budget and caches in `backend/src/delineation/`). A route that accepts an unbounded area or box is High.

### 3. Lambda ceiling

`infra/lambda.tf` and `infra/variables.tf`:

- `reserved_concurrent_executions = var.lambda_reserved_concurrency` is set (the hard cap a distributed flood hits). Unset or `-1` is Critical.
- `lambda_memory_mb` × `lambda_timeout_seconds` × concurrency gives the worst case per hour; check the comment in `infra/lambda.tf` still matches the defaults.
- The timeout stays within the validated 25–30 s and equal to CloudFront's origin read timeout (`infra/s3_cloudfront.tf`), so no request is billed after the viewer gave up.

### 4. Budget and alarms

`infra/alarms.tf`:

- `aws_budgets_budget.monthly` exists when `budget_monthly_usd > 0`, with forecasted 100 %, actual 80 % and actual 100 % notifications and `cost_types { include_credit = false, include_refund = false }`. Forecasted is the only one that catches a runaway during the month; missing it is High. The actual line must sit above the fixed baseline (about $11.80, $13.60 with VAT; `infra/README.md` § Cost) or it fires monthly and gets ignored. `budget_monthly_usd = 0` needs the explicit `no_budget_acknowledged = true` (variables.tf refuses it otherwise) and is allowed only until IAM billing access is on (say so as a manual check).
- Alarms on Lambda invocations per hour (`lambda_invocations_alarm_per_hour`), throttles, errors and duration, CloudFront requests and bytes per hour (`cloudfront_requests_alarm_per_hour`, `cloudfront_gb_alarm_per_hour`: the edge is the one path no cap bounds), CloudFront 5xx and WAF blocks, and the SES bounce and complaint rates; all publish to topics with `alert_email` subscribed. `alert_email` is required and refused on reserved example domains (variables.tf); an unconfirmed subscription is a manual check (docs/deployment.md § First deploy fires a test alarm in each region).

### 5. Log retention

- Every `aws_cloudwatch_log_group` has `retention_in_days` set (`lambda_log_retention_days`, 30 by default). Unbounded retention is High.
- Logs are event names, not request bodies (`backend/src/http/logError.ts`), so volume grows with errors, not with traffic.

### 6. CloudFront and S3

`infra/s3_cloudfront.tf`:

- `price_class` is `PriceClass_100` or `_200`, not `_All` (the audience is South African).
- `/tiles/*` is cached (long TTLs, range requests) so the basemap and terrain don't re-read the origin per view; the tiles are IC-WBT's bucket read cross-account (`docs/data.md` § Cross-account access), so check who pays for those GETs and egress.
- The site bucket: versioning and a lifecycle for non-current versions, if versioning is on.

### 7. Cross-account data reads

`infra/lambda.tf` (`lambda_cross_account_read`) and `docs/data.md`:

- Reads are `GetObject` on the CHIRPS mirror's `rnl/*` and one MAP-grid key, `ListBucket` only under `rnl/`; nothing broader can be read (and billed) by a bug.
- The CHIRPS and MAP-grid readers cache what they read (`backend/src/chirps/`, `backend/src/mapgrid/`), so a repeated area costs no second read.

### 8. SES

`infra/ses.tf`, `infra/mail_queue.tf`, `backend/src/auth/mail.ts`, `backend/src/auth/mailWorker.ts`:

- Mail is sent only for sign-in codes, and auth-kit's per-address limits (60 s apart, 5 an hour, 10 a day) plus the WAF auth rule bound it. A path that sends mail without them is High.
- The SES client's retries are bounded (`SES_SEND_WORST_CASE_MS`), and a failed send is logged and retried by SQS at most 3 times (the mail queue's `maxReceiveCount`), then dead-lettered, never retried in a loop.
- The sign-in mail queue (`aws_sqs_queue.mail_send`) keeps a message no longer than a code lives (10 minutes) and has a DLQ, and its event source mapping is capped at 2 concurrent batches, so a backlog can't fan out into the Lambda's whole reserved concurrency.
- The bounce/complaint queue (`aws_sqs_queue.mail_events`) has a DLQ and a redrive limit, so a poison message can't keep the Lambda busy.

### 9. DynamoDB

`infra/users.tf`: the user table is on-demand (or provisioned with a ceiling); the alarm on `users_table` covers throttles or errors. Point-in-time recovery cost is accepted (it is the erasure window in `docs/security.md` § Erasure).

### 10. Cape Farm Mapper

`backend/src/cfm/`: each `/cfm/land-use` call may cost up to 40 upstream pages; it is rate-limited (`landUse`) and cached. Confirm the token is used only by the backend and the fan-out can't be driven unbounded by one request.

### 11. Documentation matches reality

- `docs/security.md` § Infrastructure ("Spend is bounded") states the reserved concurrency, the worst-case daily cost and the alarms; check the numbers against `infra/variables.tf`.
- `infra/README.md` and `docs/deployment.md` describe the same knobs.

## Report

- **Critical**: no reserved concurrency on the Lambda; a costly data route answering without a session; the shared-secret check bypassable; no budget at all once billing access is on.
- **High**: a costly route with no rate limit or no input cap; no forecasted budget notification; unbounded log retention; CloudFront `PriceClass_All` without a reason; a mail path outside auth-kit's limits.
- **Medium**: no lifecycle on non-current versions; a cache missing on a repeated upstream read; the CHIRPS or MAP-grid grant broader than its prefix.
- **Low**: doc drift between `docs/security.md` and the configured values; an alarm with no subscriber.

For each finding: file:line and the concrete change. Don't apply fixes without explicit confirmation.

## Useful starting points

- `backend/src/app.ts` — the gate, the shared secret, `RATE_LIMITS`
- `backend/src/http/rateLimit.ts`, `backend/src/http/area.ts` — the limiter and the input caps
- `infra/lambda.tf`, `infra/variables.tf` — memory, timeout, concurrency, log retention, cross-account grants
- `infra/waf.tf` — per-IP limits
- `infra/alarms.tf` — budget and alarms
- `infra/s3_cloudfront.tf` — price class, `/tiles/*`, origin timeout
- `infra/ses.tf`, `infra/users.tf` — mail and the user table
- `docs/security.md` § Infrastructure, `docs/data.md` § Cross-account access

## Delegate to

The `infra-auditor` agent with `"Audit area: cost"` as the prompt's first sentence, plus this file's checklist. It knows the Terraform and the cross-account grants in depth.

Read-only. Findings only. The audit must NOT mutate IaC, run `terraform plan` with real credentials, call AWS or Cape Farm Mapper, or load-test the backend: a load test is itself a spend event.
