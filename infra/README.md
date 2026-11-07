# Infrastructure

Terraform for Pitman's production stack at `pitman.jaredhoward.com`, in
Pitman's own AWS account. **How to deploy it (the operator's numbered
first-deploy runbook), the CI variables, the Lambda environment and what
IC-WBT must grant: `docs/deployment.md`.** This file is the map of the code.

## What it creates

| File | Resources |
|---|---|
| `main.tf` | Providers: primary `aws_region` (`af-south-1`, D-6) and `aws.us_east_1` (CloudFront's certificate, WAF and metrics); partial S3 backend (bucket and region from `backend.config`) |
| `s3_cloudfront.tf` | Private site bucket (`pitman-frontend-<account>`, OAC-only, TLS-only); ACM certificate (us-east-1) validated in the delegated child zone, which is **looked up** (`data.aws_route53_zone`), never created; CloudFront with two behaviours: default → S3 (`functions/spa_rewrite.js`), `/api/*` → Lambda Function URL (`functions/api_strip_prefix.js`, shared-secret header, caching off, 30 s read timeout); A + AAAA alias records |
| `security_headers.tf` + `csp.json` | Response-headers policies: the site's strict CSP (split with SvelteKit's meta-tag hash; the reasoning is in the file), HSTS, nosniff, DENY framing, COOP, Permissions-Policy; the API's `default-src 'none'` |
| `waf.tf` | WAFv2 web ACL (us-east-1): per-IP rate limits on `/api/auth/*` (100 / 5 min, evaluated first), `/api/*` (300 / 5 min) and every path (2 000 / 5 min) |
| `lambda.tf` | API Lambda (Node 24, arm64, 1 024 MB, 30 s, reserved concurrency 10), its log group (30 days), its role (own log group only, plus the cross-account read of IC-WBT's `rnl/*` and MAP-grid file, each conditioned on IC-WBT's account and present only once configured), its environment (incl. the sign-in variables, `docs/deployment.md` § Lambda environment), the NONE-auth Function URL |
| `users.tf` | The user table `pitman-users` (DynamoDB on-demand, `pk`/`sk`, TTL on `ttl`, PITR, deletion protection, AWS-owned key; A-AUTH-4). Grants the Lambda exactly auth-kit's six actions (`GetItem`, `Query`, `PutItem`, `UpdateItem`, `DeleteItem`, `ConditionCheckItem`) on the table ARN only: no `Scan`, no `Batch*`, no index ARN. The two sign-in keys (`random_password.auth_code_key`, `random_password.auth_session_key`; A-AUTH-8) |
| `ses.tf` | SES v2 sender (A-AUTH-7): identity `pitman.jaredhoward.com` with Easy DKIM (3 CNAMEs, af-south-1's regional DKIM domain), MAIL FROM `send.<domain>` (MX + SPF), DMARC `p=none` on `_dmarc.<domain>`; configuration set `pitman` (TLS required, suppression of bounces and complaints, reputation metrics, CloudWatch event counts). Grants the Lambda `ses:SendEmail` on the identity and the configuration set only, when From is `no-reply@<domain>`; never `ses:DeleteSuppressedDestination`. Bounces and complaints: SNS `pitman-ses-events` (only this configuration set may publish) → SQS `pitman-mail-events` (only that topic may send; SSE; DLQ after 5 tries) → an event source mapping on the same API Lambda (batch 10, at most 2 at once, `ReportBatchItemFailures`), which may only receive, delete and read attributes on that queue |
| `alarms.tf` | Monthly budget; SNS topics in both regions (alarms can only notify a topic in their own region); alarms on Lambda errors, throttles, invocations per hour and p95 duration, CloudFront 5xx, WAF blocks (all rules, and the auth rule alone), SES bounce and complaint rates, user-table throttles and system errors, `auth.locked` log lines, and the mail-events DLQ |
| `oidc.tf` | Looks up the bootstrap's `pitman-deploy` role and attaches the deploy policy: sync the site bucket, invalidate this distribution, update this function's code. Nothing else |
| `outputs.tf` | What `export-tf-vars.sh` pushes to repo variables, plus `lambda_role_arn` for IC-WBT's bucket policies |

Created elsewhere, by the estate bootstrap (`~/github/templates/scripts/new-project-account.sh pitman`): the account, the tfstate bucket, `alias/pitman-sops`, the GitHub OIDC provider and deploy role (trust pinned to `repo:Absence0760/pitman:environment:production`), the `pitman.jaredhoward.com` zone and its delegation, the `production` environment.

## Checks (credential-free)

- `terraform fmt -check -recursive infra && terraform -chdir=infra init -backend=false && terraform -chdir=infra validate`: also CI (`terraform.yml`).
- `terraform -chdir=infra test`: mocked providers, `command = plan`. `tests/stack.tftest.hcl` pins the cross-account grants statement by statement, the Lambda's bounds, the CSP's strictness, the `/api/*` behaviour and the WAF scope. `tests/auth.tftest.hcl` (#28) pins the region refusal, the user table's PITR / TTL / deletion protection, the table, SES and queue grants action by action and ARN by ARN (and that no Lambda policy holds `DeleteSuppressedDestination`), the sign-in environment and its two distinct keys, `/api/*` uncached with cookies and `Origin` forwarded, the auth WAF rule and the new alarms.
- `node --test infra/scripts/*.test.mjs`: the CSP guard (`scripts/check-csp.mjs`, which `deploy-frontend.yml` runs on every build) and the two CloudFront functions.

Never `terraform apply` from a Claude session, nor a plan against the real backend: those are the operator's (`docs/deployment.md`).

## Notes

- **Provider: hashicorp/aws 6.x** (`~> 6.70`, locked 6.71.0, Dependabot #2). The 5 → 6 upgrade needed no resource changes here; v6's per-resource `region` argument isn't used (the `us_east_1` alias stays, as in IC-WBT).
- **Function URL permissions**: the provider adds both public-invoke statements itself when it creates a NONE URL (since 6.28); don't declare `aws_lambda_permission` for it (`lambda.tf`).
- **Secrets** in state: `random_password.cloudfront_shared_secret`, `auth_code_key` and `auth_session_key`; rotation in `docs/deployment.md` § Secrets.
- **The user table can't be destroyed by Terraform**: deletion protection is on, so `destroy` (or a change that forces replacement) fails on it until it is turned off by hand.
- **The deploy role needs nothing new for sign-in**: the table, SES and the queue are Terraform's; the deploy only replaces the function's code (`oidc.tf`).
- **Tearing down**: `AWS_PROFILE=pitman terraform -chdir=infra destroy`. The tfstate bucket and the zone belong to the bootstrap and survive.
