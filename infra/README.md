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
| `waf.tf` | WAFv2 web ACL (us-east-1): per-IP rate limits on `/api/*` (300 / 5 min) and on every path (2 000 / 5 min) |
| `lambda.tf` | API Lambda (Node 24, arm64, 1 024 MB, 30 s, reserved concurrency 10), its log group (30 days), its role (own log group only, plus the cross-account read of IC-WBT's `rnl/*` and MAP-grid file, each conditioned on IC-WBT's account and present only once configured), the NONE-auth Function URL |
| `alarms.tf` | Monthly budget; SNS topics in both regions (alarms can only notify a topic in their own region); alarms on Lambda errors, throttles, invocations per hour and p95 duration, CloudFront 5xx, WAF blocks |
| `oidc.tf` | Looks up the bootstrap's `pitman-deploy` role and attaches the deploy policy: sync the site bucket, invalidate this distribution, update this function's code. Nothing else |
| `outputs.tf` | What `export-tf-vars.sh` pushes to repo variables, plus `lambda_role_arn` for IC-WBT's bucket policies |

Created elsewhere, by the estate bootstrap (`~/github/templates/scripts/new-project-account.sh pitman`): the account, the tfstate bucket, `alias/pitman-sops`, the GitHub OIDC provider and deploy role (trust pinned to `repo:Absence0760/pitman:environment:production`), the `pitman.jaredhoward.com` zone and its delegation, the `production` environment.

## Checks (credential-free)

- `terraform fmt -check -recursive infra && terraform -chdir=infra init -backend=false && terraform -chdir=infra validate`: also CI (`terraform.yml`).
- `terraform -chdir=infra test`: `tests/stack.tftest.hcl`, mocked providers, `command = plan`. Pins the cross-account grants statement by statement, the Lambda's bounds, the CSP's strictness, the `/api/*` behaviour and the WAF scope.
- `node --test infra/scripts/*.test.mjs`: the CSP guard (`scripts/check-csp.mjs`, which `deploy-frontend.yml` runs on every build) and the two CloudFront functions.

Never `terraform apply` from a Claude session, nor a plan against the real backend: those are the operator's (`docs/deployment.md`).

## Notes

- **Provider: hashicorp/aws 6.x** (`~> 6.70`, locked 6.71.0, Dependabot #2). The 5 → 6 upgrade needed no resource changes here; v6's per-resource `region` argument isn't used (the `us_east_1` alias stays, as in IC-WBT).
- **Function URL permissions**: the provider adds both public-invoke statements itself when it creates a NONE URL (since 6.28); don't declare `aws_lambda_permission` for it (`lambda.tf`).
- **Shared secret** in state: `random_password.cloudfront_shared_secret`; rotation in `docs/deployment.md` § Secrets.
- **Tearing down**: `AWS_PROFILE=pitman terraform -chdir=infra destroy`. The tfstate bucket and the zone belong to the bootstrap and survive.
