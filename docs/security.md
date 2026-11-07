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
  `'unsafe-eval'`, and no style `'unsafe-inline'` (the two inline styles,
  `app.html`'s and SvelteKit's route announcer, are allowed by hash). The map
  added no source: MapLibre's worker is a chunk of the page build, so
  `worker-src 'self'` holds with no `blob:`; tiles and glyphs are same-origin
  under `/tiles/*`; its `data:` zoom icons are replaced by text, so `img-src`
  stays `'self'` (R5-M6). `frontend/e2e/map.spec.ts` runs the real MapLibre
  under this header and fails on any violation. The header's `script-src` carries `'unsafe-inline'`
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

## Planned: users and sign-in

Not built. Issue #28 plans an admin-kept user list with email-code sign-in
gating `/api/*` (except `/health`). The sign-in, session and user-management
code comes from the shared private package `Absence0760/auth-kit` at a pinned
tag (decision A-AUTH-0); pitman keeps its own user table, admins, SES sender,
privacy notice and AWS account. Until #28 lands the API is open, as described
above. The design, proposed as A-AUTH-1 … 11 in `docs/decisions.md`:

- **What is gated.** Every `/api/*` route but `/health` answers 401 without a
  valid session. The static site, `/methods`, `/privacy`, `/sign-in` and
  `/tiles/*` stay public; nothing in them is private (A-AUTH-1).
- **The code is the only factor**, so auth-kit's rules are strict: a 6-digit
  code kept only as an HMAC, 10 minutes, one live code per address, spent
  after 3 wrong tries; sends 60 s apart, 5 an hour, 10 a day; a lockout that
  doubles to 15 minutes. Expiry is checked in code, never left to TTL.
- **Nothing reveals who is listed.** Every code request answers 202 after a
  fixed minimum time; listed and unlisted addresses do the same store work.
  Strangers' addresses are stored only as HMACs.
- **Sessions**: `__Host-pitman_session` (`Secure; HttpOnly; SameSite=Strict;
  Path=/`), HS256 with `jti` and `kid`, 7 days, re-checked against the user
  record and revocations on every request. `/api/*` is never cached at the
  edge (a `terraform test` pins it).
- **Admin rules**: admins only; nobody removes or demotes themself; there is
  always at least one admin. Each change is one DynamoDB transaction with its
  audit row (24 months).
- **Request checks**: `csrf()` on `ALLOWED_ORIGINS`, JSON bodies only (415),
  `no-store` on auth and user routes, a WAF limit of 100 per 5 minutes per IP
  on `/api/auth/*`.
- **Keys**: two Terraform `random_password` values in the Lambda's
  environment; a missing key or table makes data routes answer 503.
- **Logs**: user ids and event names only; `auth.locked` raises an alarm.
- **Data residency**: the table and SES live in af-south-1; Terraform refuses
  another region unless `data_outside_south_africa = true` and the privacy
  notice is rewritten.
- **Known risks**: anyone can lock out an admin by failing codes against
  their address (alarm on `auth.locked`, `pnpm admin:recover`, keep two
  admins); SES production access can take days; signing keys are visible in
  the Lambda's environment and Terraform state, the same accepted gap as the
  CloudFront secret.

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
- Dependency scanning is weekly, not per change: `.github/workflows/audit.yml`
  runs `pnpm audit --audit-level=moderate` every Monday and opens a
  `dependency-audit` issue (closed by the next clean run), and Dependabot
  raises update PRs. Low-severity findings are not reported.
