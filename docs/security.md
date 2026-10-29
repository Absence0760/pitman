# Security

Cross-cutting security considerations for this project.

## Secrets management

- **Secrets live outside this repo, in `infra-secrets`.** Production secrets are
  SOPS + AWS-KMS-encrypted in the private estate repo
  `infra-secrets/<project-slug>/prod.sops.yaml` (under `alias/<project-slug>-sops`),
  not committed here. Decryption is gated by IAM (`kms:Decrypt`). See
  `../infra-secrets/README.md`.
- **No key file on disk.** Access is bound to AWS IAM. Recovery from laptop
  loss is "log in on a new machine, `aws configure`, decrypt."
- **CloudTrail logs every `kms:Decrypt` call.**
- **Annual key-material rotation** is enabled on the KMS key.
- **Plaintext secrets are gitignored.** `.gitignore` covers `.env`,
  `.env.*.local`, and `*.tfvars`. The committed `.env.development` is the
  exception — it holds only non-sensitive local defaults (localhost URLs,
  ports), never real secrets; those stay SOPS-encrypted (`*.sops`) or in a
  gitignored `.env.development.local`.
- **No decrypted secret is written to disk** — Terraform's `carlpett/sops` provider decrypts `infra-secrets`' files in-memory at plan/apply.
- **CI/CD uses GitHub OIDC** — no long-lived AWS access keys in GitHub secrets.

## CORS

`ALLOWED_ORIGINS` is a comma-separated env var checked by `hono/cors`
middleware. Only listed origins receive `access-control-allow-origin` headers.

## Infrastructure

The Terraform is `infra/`; `infra/README.md` maps it, `docs/deployment.md`
runs it.

- **Deploys need a human.** The deploy role (the estate bootstrap's
  `pitman-deploy`) trusts only GitHub OIDC tokens whose `sub` is
  `repo:Absence0760/pitman:environment:production`, and the `production`
  environment has the operator as required reviewer, so every deploy run waits
  for an approval. Only the deploy jobs request `id-token: write`. No static
  AWS key exists anywhere.
- **The deploy role can do three things**: write the site bucket, invalidate
  this distribution, replace this function's code (`infra/oidc.tf`). It
  cannot change IAM, configuration or anything else.
- **S3 site bucket** blocks public access, enforces TLS, and is readable only
  by this distribution through OAC (`AWS:SourceArn`).
- **The API is reachable only through CloudFront.** The Function URL is
  public by AWS design; CloudFront adds `X-CloudFront-Shared-Secret` (a
  Terraform-generated 48-character value) and the app answers 403 to any
  request without it, so the WAF and its rate limits cover the API. Not
  Lambda OAC: it would need the viewer to sign every POST body's hash.
- **WAF** (us-east-1): per-IP rate limits, 300 per 5 minutes on `/api/*`
  (path URL-decoded, normalised and lower-cased before matching) and 2 000 on
  every path. No managed rule groups (their 8 KB body limit would block
  polygon POSTs); the API checks its own input sizes.
- **Strict CSP**, from CloudFront: `default-src 'self'`, `connect-src 'self'`,
  `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`, no
  `'unsafe-eval'`, and no style `'unsafe-inline'` (the one inline style is
  allowed by hash). The header's `script-src` carries `'unsafe-inline'`
  only because SvelteKit's per-build bootstrap hash can't be in a static
  header; SvelteKit's meta-tag CSP (hash mode) narrows it to that one hash,
  and `deploy-frontend.yml` refuses any build without it
  (`infra/scripts/check-csp.mjs`). The full reasoning is in
  `infra/security_headers.tf`. Plus HSTS (2 years), nosniff, DENY framing,
  COOP same-origin, a Permissions-Policy; the API's responses get
  `default-src 'none'`.
- **Spend is bounded**: the Lambda's reserved concurrency (10) caps what a
  flood can cost (about $15 a day at 1 GB), with alarms on invocations per
  hour, throttles, errors and duration, a monthly budget (forecast and
  actual), and WAF-block and CloudFront-5xx alarms.
- **Cross-account reads are least-privilege**: the Lambda role may
  `GetObject` IC-WBT's `rnl/*` (and the root `zarr.json`) and one MAP-grid
  key, and `ListBucket` the mirror only under `rnl/`, every statement
  conditioned on `s3:ResourceAccount` = IC-WBT's account. IC-WBT's bucket
  policies name the role by exact ARN (`docs/deployment.md` § What IC-WBT
  must grant). Read-only, no KMS, no other prefix. `infra/tests/` pins it.
- **Logs** are kept 30 days; the Lambda may write only its own log group.

## Incident playbook

1. **Suspected secret leak** — rotate at the source dashboard, update
   `../infra-secrets/<project-slug>/prod.sops.yaml` (`sops`), run `terraform apply`.
2. **IAM credential leaked** — deactivate immediately, check CloudTrail,
   rotate all secrets if `kms:Decrypt` was available.
3. **AWS account compromised** — full account recovery, rotate everything,
   re-provision infrastructure.

## Known gaps

- The WAF limits are per IP; a flood spread over many addresses is bounded by
  reserved concurrency and surfaced by the invocation alarm and the budget,
  not blocked.
- The CloudFront shared secret sits in the Lambda's environment and the
  Terraform state (both in-account, encrypted at rest), not Secrets Manager.
- No automated dependency scanning (consider `pnpm audit` in CI).
