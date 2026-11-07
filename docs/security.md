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

## CORS and cross-site requests

`ALLOWED_ORIGINS` is a comma-separated env var checked by `hono/cors`
middleware. Only listed origins receive `access-control-allow-origin` headers,
and never `access-control-allow-credentials`: the browser calls the API
same-origin, so the session cookie never needs CORS. Hono `csrf()` refuses an
unsafe request with a form-like body from any other origin (403), and every
body must be JSON (415). On top of both, every request other than GET, HEAD
and OPTIONS, whatever its content type, must say it comes from the site:
`Sec-Fetch-Site: same-origin`, or an `Origin` in `ALLOWED_ORIGINS`; anything
else, a request with neither header included, is 403
(`backend/src/http/sameOrigin.ts`). So cross-origin JSON doesn't depend on the
browser's preflight and the cookie's `SameSite=Strict` alone, and a sibling
`*.jaredhoward.com` (`Sec-Fetch-Site: same-site`) can't write.

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
  request without it, so the WAF and its rate limits cover the API. On
  Lambda an unset or empty secret fails closed: every request is 503 and
  `{"event":"cloudfront_secret.unset"}` is logged at start (`app.ts`), so a
  lost variable can't open the Function URL past the WAF. Not
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

## Users and sign-in

Issue #28, decided as A-AUTH-0 … 11 in `docs/decisions.md` (2026-11-07). The
sign-in, session and user-management code comes from the shared private
package `Absence0760/auth-kit` at a pinned tag (A-AUTH-0, `v0.1.2`); pitman
keeps its own routes, gate, mail, cookie, user table, admins, SES sender,
privacy notice and AWS account. Network files still never leave the browser.

**Built in the backend (#28 P3, P4)** — `backend/src/auth/`, routes in
`docs/architecture.md` § Sign-in:

- **What is gated.** Every API route but `/health` and the three sign-in
  routes (`POST /auth/code`, `/auth/verify`, `/auth/logout`) answers 401
  without a valid session. The gate is registered once, before every data
  route, so a new route is gated by default; `auth/routes.test.ts` enumerates
  the app's routes to prove none answers without a session. An unknown path
  is 401 too, so the API doesn't reveal which routes exist (A-AUTH-1).
- **The code is the only factor**, so auth-kit's rules are strict: a 6-digit
  code kept only as an HMAC, 10 minutes, one live code per address, spent
  after 3 wrong tries; sends 60 s apart, 5 an hour, 10 a day; a lockout that
  doubles to 15 minutes. Expiry is checked in code, never left to TTL.
- **Nothing reveals who is listed.** Every code request answers 202 with the
  same body and headers inside `withMinimumLatency` (1 s), the email sent
  inside it; listed and unlisted addresses do the same store work, and a
  failed send still answers 202. Strangers' addresses are stored only as HMACs.
- **Sessions**: `__Host-pitman_session` (`Secure; HttpOnly; SameSite=Strict;
  Path=/`, no `Domain`), HS256 with `jti` and `kid`, 7 days, re-checked
  against the user record and revocations on every request, so a removal or
  demotion bites on the next request. "Sign out" revokes the `jti`; "sign out
  everywhere" moves the user's watermark. Local dev over http may use a plain
  `pitman_session` without `Secure` (`AUTH_DEV_COOKIE=true`), which the config
  refuses on Lambda.
- **Admin rules**: admins only (403); nobody removes or demotes themself
  (400); there is always at least one admin (409). Each change is one
  DynamoDB transaction with its audit row (24 months). The races (two admins
  demoting each other, or the same third; a double bootstrap) run against
  DynamoDB Local in CI (`auth/dynamo.test.ts`).
- **Request checks**: Hono `csrf()` on `ALLOWED_ORIGINS` (a cross-origin form,
  multipart or text/plain body is 403); every state-changing request must
  carry `Sec-Fetch-Site: same-origin` or an allowed `Origin`, JSON included
  (403, § CORS and cross-site requests); JSON bodies only (415); CORS without
  credentials (the browser calls the API same-origin, through CloudFront or
  the dev proxy); `Cache-Control: no-store` on `/auth/*`, `/users*` and
  `/audit`; a per-instance limit of 60 requests per 10 minutes per client on
  those paths.
- **Fails closed**: on Lambda, a missing or short key (under 32 characters),
  equal keys, a missing table, `USER_STORE=memory`, a mail transport other
  than SES, or the dev cookie leaves sign-in unconfigured, and every gated
  route answers 503 (`auth/config.ts`).
- **Logs**: an event name and at most a user id: `auth.locked` (when a lock
  starts), `mail.send_failed`, `mail.bounce`, `mail.complaint`,
  `auth.unconfigured`. Never an address, a code or a token; every auth test
  file fails if any line it logs holds an address
  (`src/__tests__/logGuard.ts`). The console transport (dev) masks the address.
- **Operator actions** (`pnpm admin:bootstrap`, `admin:recover`,
  `admin:clear-lock`, `admin:erase`) run with the operator's AWS profile, read
  the address from stdin (never argv, so never shell history), read the code
  key from the Lambda's environment rather than having anyone type it, and
  are audited as `operator`. `admin:erase` also clears the address's SES
  suppression itself (§ Erasure), so no command ever carries an address.

Bounced addresses are logged now, and flagged on the Users page once auth-kit
v0.2.0 lands.

- **Data residency**: the table and SES live in af-south-1; Terraform refuses
  another region unless `data_outside_south_africa = true` and the privacy
  notice is rewritten (P2).
- **Infra (P2, in `infra/`):** the table (`users.tf`), the SES sender and
  its bounce queue (`ses.tf`), the auth WAF rule and the alarms are written
  and pinned by `infra/tests/auth.tftest.hcl`. The Lambda's grants: auth-kit's
  six DynamoDB actions on the table ARN only; `ses:SendEmail` on the domain
  identity and the configuration set only, when From is
  `no-reply@pitman.jaredhoward.com`; receive / delete / get-attributes on the
  bounce queue only. Never `Scan`, `Batch*` or
  `ses:DeleteSuppressedDestination`. Not yet applied (no account yet, #22).
- **Keys**: two Terraform `random_password` values in the Lambda's
  environment (`AUTH_CODE_KEY`, `AUTH_SESSION_KEY`); rotating with
  `-replace` signs everyone out (rotating `AUTH_CODE_KEY` also forgets live
  codes and locks, and changes the `erased:` pseudonym of later erasures).
- **Known risks**: anyone can lock out an admin by failing codes against
  their address (alarm on `auth.locked`; `pnpm admin:clear-lock`, or
  `pnpm admin:recover` to restore admin rights; keep two admins); SES
  production access can take days; signing keys are visible in the Lambda's
  environment and Terraform state, the same accepted gap as the CloudFront
  secret.

## Erasure

A request to erase a person's address (POPIA), in order:

1. **An admin removes the user** on the Users page (`DELETE /users/:id`),
   which deletes their user, address, code and lock items. Skip if they are
   no longer listed.
2. **The operator runs `pnpm admin:erase`** and types the address when asked.
   It removes the user if still listed (refused if they are the last admin),
   deletes the code and lock items, and replaces the address with
   `erased:<hmac>` in every audit row and in other users' "added by". It is
   audited as `erase`.
3. **The same script removes the address from SES's account-level
   suppression list** (SES v2 `DeleteSuppressedDestination` in af-south-1,
   with the operator's profile), using the address it already read, so the
   address is never typed into a shell command or kept in shell history. It
   prints whether the address was removed or was never on the list
   (`NotFoundException`). If SES refuses (the profile needs
   `ses:DeleteSuppressedDestination`), it says so by error name and exits 1;
   run it again with the same address once fixed (step 2 is safe to repeat).
   The Lambda has no permission to do this. Not yet checked (no account,
   #22): whether CloudTrail records the address as the call's request
   parameter; check it at the first erasure and note the answer here.
4. **Record it**: the date, and that steps 1 to 3 are done (not the
   address). Erasure is complete 35 days later, when point-in-time recovery
   no longer holds the deleted items.

## Incident playbook

1. **Suspected secret leak** — rotate at the source dashboard, update
   `../infra-secrets/<project-slug>/prod.sops.yaml` (`sops`), run `terraform apply`.
2. **IAM credential leaked** — deactivate immediately, check CloudTrail,
   rotate all secrets if `kms:Decrypt` was available.
3. **AWS account compromised** — full account recovery, rotate everything,
   re-provision infrastructure.
4. **Someone is locked out of sign-in** (an `auth.locked` alarm, or a user
   reports it) — `pnpm admin:clear-lock` clears the lock without changing
   their role; `pnpm admin:recover` also makes them an admin (the way back in
   when no admin can sign in). Both are audited.
5. **A session or an admin's mailbox is compromised** — another admin removes
   or demotes the user (it bites on their next request); the user can also
   use "sign out everywhere". Rotating `AUTH_SESSION_KEY`
   (`terraform apply -replace`) signs everyone out.

## Known gaps

- The WAF limits are per IP; a flood spread over many addresses is bounded by
  reserved concurrency and surfaced by the invocation alarm and the budget,
  not blocked.
- The CloudFront shared secret and the two sign-in keys (`AUTH_CODE_KEY`,
  `AUTH_SESSION_KEY`) sit in the Lambda's environment and the Terraform
  state (both in-account, encrypted at rest), not Secrets Manager. Anyone who
  can read the function's configuration can mint a session (A-AUTH-8 accepts
  this; the account is the root of trust).
- Dependency scanning is weekly, not per change: `.github/workflows/audit.yml`
  runs `pnpm audit --audit-level=moderate` every Monday and opens a
  `dependency-audit` issue (closed by the next clean run), and Dependabot
  raises update PRs. Low-severity findings are not reported.
