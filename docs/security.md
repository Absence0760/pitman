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
  ports), never real secrets; those stay SOPS-encrypted in `infra-secrets` or
  in a gitignored `.env.development.local`.
- **The committed env files are guarded** (`pnpm check:env`,
  `scripts/ci-guards/env-isolation.mjs`, CI job `env-isolation` in the CI
  gate). The only tracked env files are `*.env.development` and
  `*.env.example`; no `*.tfvars` or sops file is tracked. In the dev defaults
  every host is local, every email address is on a reserved domain
  (`example.test`, `localhost`), a key named `*_KEY` / `*_SECRET` / `*_TOKEN` /
  `*_PASSWORD` is empty or `dev-only-…`, no AWS credential or profile is set,
  every data `*_SOURCE` is `local` with its `*_LOCAL_FILE` / `*_LOCAL_DIR`
  inside the workspace, the user store is memory or DynamoDB Local
  (`*-local` table) and mail goes to the console or Mailpit. Frontend env
  files hold `PUBLIC_*` keys only, with `PUBLIC_API_URL=/api`. It reports
  file, line and rule, never a value. gitleaks catches credential shapes;
  this catches a real value of a harmless-looking shape.
- **No decrypted secret is written to disk** — Terraform's `carlpett/sops` provider decrypts `infra-secrets`' files in-memory at plan/apply.
- **CI/CD uses GitHub OIDC** — no long-lived AWS access keys in GitHub secrets.

## Public repo hygiene

Pitman is meant to be a public MIT repo, and anything committed, history
included, is readable by anyone once it is. So no client data and no name
that points at a client study (CLAUDE.md rule 2): reference networks, reports
and study files live in `../pitman-private`, and fixtures, test names,
comments, commit messages and doc examples are synthetic, the byte-exact
WRSM2000 files under `docs/formats/examples/` included.

- **Client terms guard.** The farm, client and place names of real studies
  are listed in `../infra-secrets/pitman/client-terms.txt` (or
  `$CLIENT_TERMS_FILE`), outside this repo, because the list itself names the
  clients. One term per line, `#` starts a comment; matching ignores case, a
  space in a term also matches nothing, `_`, `-` or a comment line break (so
  "Some River" catches `SomeRiver` and `some-river`), and a term matches only
  as a whole word. `scripts/ci-guards/check_client_terms.mjs` checks against
  it: the pre-commit hook (staged lines and paths), the commit-msg hook (the
  message), `pnpm check:terms` (every tracked file and path) and
  `pnpm check:terms --history` (every commit and message on every ref). It
  looks for the list beside the checkout and, in a linked worktree (under
  `.claude/worktrees/` or `../<slug>`), beside the main checkout too.
- **It never prints a term**, only the file, the line and the term's number
  in the list; a path that contains a term is printed with `[term #N]` in its
  place. A CI log is as public as the repo.
- **No list, no check, no noise.** Without the file (CI, a fresh clone, an
  outside contributor) the guard is a no-op: the hooks exit 0 silently and the
  full scan prints one "skipping" line. It never blocks work it cannot check,
  so add a term the moment a new client name turns up.
- **The hooks install themselves.** The repo's hooks live in `.githooks/`
  (`pre-commit`, `commit-msg`, `pre-push`), and the root `prepare` script
  (`scripts/git-hooks/install.mjs`) sets `core.hooksPath` to it on every
  `pnpm install`, so the main checkout and every worktree run them, for a
  person's commits and a Claude session's alike. It skips CI and anything
  outside a git checkout, and leaves a `core.hooksPath` of your own alone with
  a warning (then this repo's hooks don't run). The hooks fail closed when
  `node` is missing. When the pre-commit framework is installed they also run
  `.pre-commit-config.yaml` (gitleaks and the file checks); `pre-commit
  install` is no longer needed, and refuses while `core.hooksPath` is set.
- **Not covered:** GitHub issue and PR text, which no hook sees. Write those
  with the same care.
- **If a term lands anyway**, take it out of HEAD and decide whether to
  rewrite history (`git filter-repo --replace-text`) before anyone opens a PR
  on it: GitHub keeps a PR's commits under `refs/pull/*` for good, so once one
  is pushed and opened, rewriting the branch does not remove it.

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
- **The API is reachable only through CloudFront, behind two locks**
  (issue #33, decision R4-I6):
  1. **Origin access control.** The Function URL is `AWS_IAM`: Lambda
     admits only SigV4-signed requests, and its resource policy lets only
     `cloudfront.amazonaws.com` sign, on behalf of this distribution
     (`source_arn`), for both `lambda:InvokeFunctionUrl` and
     `lambda:InvokeFunction` (`infra/s3_cloudfront.tf`). A call that skips
     CloudFront is refused by Lambda's front end with 403 before the
     function runs, so it is never billed, never reaches the app and never
     bypasses the WAF; the Lambda invocation metrics don't count it. The
     cost of this: CloudFront signs the body hash the viewer states, and
     Lambda takes no unsigned payloads, so the frontend sends
     `x-amz-content-sha256` (Web Crypto SHA-256 of the exact body) on
     every request other than GET and HEAD
     (`frontend/src/lib/api/content-hash.ts`, used by `sessionFetch` and the
     sign-in client). A client that leaves it off, or states a wrong hash,
     gets 403 from Lambda, not from the app. A forged hash buys nothing: it
     only makes the caller's own request fail.
  2. **The shared secret.** CloudFront adds `X-CloudFront-Shared-Secret` (a
     Terraform-generated 48-character value) and the app answers 403 to any
     request without it. On Lambda an unset or empty secret fails closed:
     every request is 503 and `{"event":"cloudfront_secret.unset"}` is
     logged at start (`app.ts`). Kept although the OAC makes it redundant
     on a correct stack, because it still holds when the first lock
     doesn't: an OAC detached or set to `never` sign, the URL put back on
     `NONE` (by mistake, or on purpose to rule the OAC out during an
     incident), or a resource-policy statement added by hand. It costs
     nothing and needs no client change; retire it only with a reason
     recorded against R4-I6.
- **WAF** (us-east-1): per-IP rate limits, 100 per 5 minutes on
  `/api/auth/*` except `/api/auth/me` (which every page load calls), 300 on
  `/api/*` and 2 000 on every path. Before matching, the path is URL-decoded,
  backslashes are turned into slashes and the path normalised
  (`NORMALIZE_PATH_WIN`: the app routes `/auth\code` as `/auth/code`), then
  lower-cased. No managed rule groups (their 8 KB body limit would block
  polygon POSTs); the API checks its own input sizes. **Sampled requests are
  off** on the ACL and every rule (metrics stay on): a sample keeps the
  request's headers, the session cookie among them, and the client IP in
  us-east-1 for about 3 hours, can't be redacted, and would put personal data
  outside af-south-1. The cost is that a WAF block can't be inspected request
  by request; the alarms and the backend's `auth.locked` / audit rows are the
  trail.
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
  `default-src 'none'`. Since R4-I14 these come from two viewer-response
  CloudFront Functions (one per behaviour, the CSP from `infra/csp.json`),
  not response headers policies, which the flat-rate Free and Pro plans
  don't allow. CloudFront runs no viewer-response function on an origin
  answer of 400 or more, so the API sets the same headers on every response
  itself (`backend/src/http/securityHeaders.ts`, tested against
  `csp.json` and the function); the one set of responses that now goes
  without them is S3's 403 AccessDenied XML for a missing file with an
  extension (fixed text, never HTML that renders), and CloudFront's own
  answers (a WAF block, the http-to-https redirect, a 502/504), which run no
  function either, and the Function URL's own 429/403 while the breaker holds
  the API at 0 (the app never runs, and the origin status is ≥ 400).
- **Spend is bounded where it can be, stopped automatically where it
  matters, and watched where it can't**: the Lambda's reserved concurrency
  (10, validated 5-10 and at most 10 GB in all) caps what a flood can cost
  ($15.28 a day, $458.27 a month, at 1 GB), and the **spend circuit breaker**
  (`infra/breaker.tf`, R4-I7) sets that concurrency to 0 by itself when 6 or
  more copies run for 15 minutes, more than 2 copy-hours run in an hour, or
  more than 3 000 invocations run in each of three 5-minute periods (a flood
  of fast requests), so sustained compute stays under about $92 a month and
  requests and their log lines under about $14. Only those three alarms may
  publish to its topic. The user table's
  on-demand throughput is capped (50 read / 10 write units a second, $43.55
  a month at most), the usage table's too (5 / 10, $23.95), each user has a
  daily quota on the costly routes (R4-D7), and the platform log lines are
  off. CloudFront, the WAF and Route 53 have no cap; 5-minute alarms on
  their requests, bytes and DNS queries are the early warning. Alarms on
  Lambda invocations, throttles, errors and duration, a monthly budget
  (gross of credits; forecast and actual) and a daily one ($2, actual),
  Cost Anomaly Detection once turned on after the first apply (R4-I13),
  and WAF-block and CloudFront-5xx alarms. Billing data lags by up to a
  day, so the budgets and anomaly alerts are the backstop behind the
  breaker and the 5-minute alarms, not the fast layer. Worst cases month by month: `infra/README.md` § Cost; resetting
  the breaker and the manual kill switches: § Incident playbook.
- **Unauthenticated `/auth/code` costs a little per call.** It is the one
  public route that writes: each accepted request (a decoy for an unlisted
  address does the same work) makes four strongly consistent reads and a
  three-item transaction on the user table (4 read and 6 write units:
  6 × $0.84/M + 4 × $0.168/M ≈ $0.0000057) and one SQS send plus its
  receive and delete (3 × $0.476/M ≈ $0.0000014), so about $7 per million
  calls, plus the Lambda's 1 s floor at 1 GB ($0.0000177). Bounded by the
  WAF's auth rule (100 per IP per 5 minutes), the user table's 10 write
  units a second (about 1.7 requests a second, after which they throttle),
  reserved concurrency, and the breaker, which trips on the 1 s floor's
  Duration once more than 2 copies' worth run for an hour (7 200 requests an
  hour). Per-address send caps keep SES at cents. Worst case: the table's
  $43.55, the queue's ~$15 and the Lambda line, all in `infra/README.md` §
  Cost.
- **Cross-account reads are least-privilege**: the Lambda role may
  `GetObject` IC-WBT's `rnl/*` (the root `zarr.json` only if
  `chirps_root_metadata` is set; off by default, as the reader never opens
  it, R4-I11) and one MAP-grid key, and `ListBucket` the mirror only under `rnl/`, every statement
  conditioned on `s3:ResourceAccount` = IC-WBT's account. IC-WBT's bucket
  policies name the role by exact ARN (`docs/deployment.md` § What IC-WBT
  must grant). Read-only, no KMS, no other prefix. `infra/tests/` pins it.
- **Logs** are kept 30 days; the Lambda may write only its own log group.

## Users and sign-in

Issue #28, decided as A-AUTH-0 … 11 in `docs/decisions.md` (2026-11-07). The
sign-in, session and user-management code comes from the shared private
package `Absence0760/auth-kit` at a pinned tag (A-AUTH-0, `v0.3.0`); pitman
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
  same body and headers inside `withMinimumLatency`. No mail is sent inside
  the request (issue #30, A-AUTH-14): a listed address enqueues one sealed
  message carrying its code, an unlisted one a decoy of the same size, so
  both make the same store calls and the same single SQS `SendMessage`
  (`auth/routes.test.ts` checks the store calls, the bodies' length and
  shape, and that no mailer runs during a request). A failed enqueue still
  answers 202. Strangers' addresses are stored only as HMACs. The floor is
  auth-kit's 1 s default (`CODE_REQUEST_MIN_LATENCY_MS` in
  `auth/runtime.ts`): with the work identical, what is left to hide is
  auth-kit's own store work, which is what that default covers. A slow SQS
  or table makes the answer late for both alike. (Before #30 the email was
  sent inside the floor, which had to outlast SES's 4 s worst case: 4.5 s.)
- **The sign-in mail queue** (`auth/mailQueue.ts`, `auth/mailWorker.ts`,
  `infra/mail_queue.tf`): each message is sealed with AES-256-GCM under a key
  derived (HKDF-SHA256, its own label) from `AUTH_CODE_KEY`, its plaintext
  padded to 512 bytes, so the queue, its DLQ, the SQS console and a redrive
  never show an address or a code, and a decoy can't be told from a real
  message by size. Rotating `AUTH_CODE_KEY` voids queued messages along with
  live codes (logged as `mail.queue_unreadable`). The same Lambda consumes the
  queue: it sends a batch's records at once, drops decoys, refuses to mail a
  code that has expired (`mail.send_expired`), and reports a refused send
  back for SQS to retry (about every 3 minutes, 3 receives, then the
  mail-send DLQ). The queue keeps a message 10 minutes, a code's life, and
  the DLQ a day. Its policy refuses non-TLS requests; the Lambda's role may
  send, receive and delete on it and nothing else. Local dev uses an
  in-process queue (`MAIL_QUEUE=inline`) that seals and opens the same way
  and sends just after the request answers; the config refuses it on
  Lambda, which freezes once it has answered.
- **Sessions**: `__Host-pitman_session` (`Secure; HttpOnly; SameSite=Strict;
  Path=/`, no `Domain`), HS256 with `jti` and `kid`, 7 days, re-checked
  against the user record and revocations on every request, so a removal or
  demotion bites on the next request. "Sign out" revokes the `jti` (kept
  until the token would have expired, with an entry in the user's session
  index since auth-kit v0.3.0, so erasure and an access request find it);
  "sign out everywhere" moves the user's watermark. Local dev over http may use a plain
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
  those paths (the client is the viewer address CloudFront appends to
  `X-Forwarded-For`, after dropping any trailing entry equal to the address
  that connected to the Function URL, so it is never the shared CloudFront
  edge; `backend/src/http/rateLimit.ts` `clientKey`), except `GET /auth/me`: every page load calls it, so counting it
  would lock a busy user, or everyone behind one NAT, out of sign-in. It is
  exempt from the WAF auth rule for the same reason, and still answers 401
  without a session.
- **Fails closed**: on Lambda, a missing or short key (under 32 characters),
  equal keys, a missing table, `USER_STORE=memory`, a mail transport other
  than SES, a mail queue other than SQS (or no `MAIL_QUEUE_URL`), or the dev
  cookie leaves sign-in unconfigured, and every gated
  route answers 503 (`auth/config.ts`).
- **Logs**: an event name and at most a user id: `auth.locked` (when a lock
  starts on a listed address), `auth.send_capped` (a listed address has just
  spent its daily send budget), `auth.slow_code_request` (a `POST /auth/code`
  ran past the 1 s floor: the table or SQS was slow), `mail.enqueue_failed`
  (the request couldn't enqueue the email), `mail.send_failed` (the worker's
  send was refused; retried), `mail.send_expired` and `mail.queue_unreadable`
  (a queued email dropped unsent; one alarm), `mail.queue_unsent` (queued mail
  arriving while sign-in is unconfigured), `mail.queue` (a batch's counts),
  `mail.bounce` and `mail.complaint` (with counts flagged,
  unchanged and refused), `mail.event_refused` (auth-kit refused a
  recipient's address or time, so that bounce or complaint was dropped
  unrecorded) and `mail.event_ignored` (a record that can't be read, or of
  another kind; both alarm through one filter, as either may mean SES's event
  shape or timestamps changed), `mail.record_failed`, `mail.events_unrecorded`,
  `auth.unconfigured`, `cloudfront_secret.unset`, and `unhandled_error` with
  the error's name and code only. Every one but `mail.bounce`,
  `mail.complaint`, `mail.queue` and `unhandled_error` raises an alarm
  (`infra/alarms.tf`), as do the mail-send DLQ and a sign-in email waiting
  over 2 minutes on the queue. No queued message's body is ever logged.
  Never an address, a code, a token or an
  error message (SES puts the recipient in its messages); every auth test
  file fails if any line it logs holds an address
  (`src/__tests__/logGuard.ts`). The console transport (dev) masks the address.
  Whether an address is listed comes from auth-kit's `listed` (beside
  `capReached`, `limit` and `lockStarted`), used for these logs only: the HTTP
  answer never depends on it (`auth/routes.test.ts` checks every combination).
- **SES send bounds**: the SES client makes at most 2 attempts, each cut off
  after 1 s (0.5 s to connect; `throwOnRequestTimeout`, without which the
  SDK only warns at the request timeout), with at most 1 s of backoff between
  them (the SDK's throttling base, 0.5 s, or 1 s under its 2026 retry
  behaviour). That is 2 × (0.5 + 1) + 1 = 4 s at worst
  (`SES_SEND_WORST_CASE_MS` in `auth/mail.ts`). A `Retry-After` on a
  throttling answer can stretch the SDK's backoff by up to 5 s, so the mailer
  also aborts any send still running at 4 s; that send is logged as
  `mail.send_failed` and SQS tries it again. Since #30 the send runs in the
  queue worker, not the request, so these bounds keep a batch short (one
  worst case, well inside the Lambda's timeout) rather than a floor. The SQS
  client on the request side is bounded the same way (`SQS_CLIENT_OPTIONS`
  in `auth/mailQueue.ts`), for a listed and an unlisted address alike.
- **Operator actions** (`pnpm admin:bootstrap`, `admin:recover`,
  `admin:clear-lock`, `admin:erase`, `admin:export`) run with the operator's
  AWS profile, read the address from stdin (never argv, so never shell
  history), read the code key from the Lambda's environment rather than
  having anyone type it, and are audited as `operator`. `admin:erase` also
  clears the address's SES suppression itself (§ Erasure), and
  `admin:export` reads it (§ Access requests), so no command ever carries an
  address.

- **Bounces and complaints are flagged.** A permanent bounce or a spam
  complaint from SES (SNS → SQS → the Lambda, the only caller) flags the
  listed user through auth-kit's `recordDeliveryProblem`, at SES's event
  time, audited as `system`; the Users page shows it until an admin clears it
  (`POST /users/:id/clear-delivery-problem`, audited as `mail.cleared`). A
  transient bounce is only logged. Events are ordered by time, so a
  redelivered or late one changes nothing; a 409 (contention) or a store error
  fails just that SQS record, which is redelivered and dead-lettered after 5
  tries (the mail-events DLQ alarm). An unlisted recipient stores nothing.

- **Data residency**: the table and SES live in af-south-1; Terraform refuses
  another region unless `data_outside_south_africa = true` and the privacy
  notice is rewritten (P2).
- **Infra (P2, in `infra/`):** the table (`users.tf`), the SES sender and
  its bounce queue (`ses.tf`), the auth WAF rule and the alarms are written
  and pinned by `infra/tests/auth.tftest.hcl`. The Lambda's grants: auth-kit's
  six DynamoDB actions on the table ARN only; `ses:SendEmail` on the domain
  identity and the configuration set only, when From is
  `no-reply@pitman.jaredhoward.com`; receive / delete / get-attributes on the
  bounce queue only; send / receive / delete / get-attributes on the sign-in
  mail queue only (`mail_queue.tf`), never on either DLQ. Never `Scan`, `Batch*` or
  `ses:DeleteSuppressedDestination`. Not yet applied (no account yet, #22).
- **Keys**: two Terraform `random_password` values in the Lambda's
  environment (`AUTH_CODE_KEY`, `AUTH_SESSION_KEY`); rotating with
  `-replace` signs everyone out (rotating `AUTH_CODE_KEY` also forgets live
  codes and locks, and changes the `erased:` pseudonym of later erasures).
- **Known risks**: anyone can lock out an admin by failing codes against
  their address (alarm on `auth.locked`; `pnpm admin:clear-lock`, or
  `pnpm admin:recover` to restore admin rights; keep two admins). Worse and
  quieter: anyone can spend an address's daily send budget (5 code requests,
  an hour's wait, 5 more) and the address then gets no code for up to 24 h,
  and again the next day; existing 7-day sessions hide it until they expire.
  It is logged as `auth.send_capped` (on the send that spends a listed
  address's day) for an alarm beside `auth.locked`; the remedy is the same
  `pnpm admin:clear-lock`, which deletes the address's send counters as well
  as its lock. The durable fix is in auth-kit: a requester must not be able
  to spend an address's whole daily budget. SES
  production access can take days; signing keys are visible in the Lambda's
  environment and Terraform state, the same accepted gap as the CloudFront
  secret.

## Access requests

A request under POPIA s23 to confirm whether Pitman holds personal
information about someone, and for a copy of it. There is no self-serve
"download my data"; the operator answers, in order:

1. **Acknowledge it and start the clock.** Note the date it arrived and
   answer within 30 days of that date. POPIA requires an answer "within a
   reasonable time" (s23(1)(b)(i)); Pitman holds itself to the 30 days PAIA
   s56(1) sets for a private body, which the Information Regulator's PAIA
   Guide also applies to POPIA requests. (POPIA s25 applies only PAIA s18 and
   s53, the form of the request.) If that can't be met, ask the requester,
   before the 30 days run out, to agree in writing to one extension of no
   more than 30 days, giving the reason and the new date, and saying they may
   complain to the Information Regulator (the PAIA s57(1)(e) model). There is
   no fee: confirming whether information is held is free under s23(1)(a),
   and Pitman charges nothing for the copy (s23(1)(b)(ii) allows only "a
   prescribed fee, if any", and none is prescribed under POPIA).
2. **Verify who is asking.** Answer only to the mailbox the request is
   about. A request from that address counts once the requester replies from
   it to the operator's acknowledgement (which proves they read that
   mailbox, not just that they typed it as the sender). A listed user can
   instead sign in once after asking: the Users page's audit log then shows
   their `signin` at that time. A request from another address is answered
   by asking the person to write from the address concerned, or to sign in;
   don't ask for an ID document, as Pitman holds nothing an ID could be
   matched to. Someone acting for the person must give written proof of
   their authority to act and to receive the information (PAIA s53(2)(f),
   applied by POPIA s25), plus proof of their own identity; send the answer
   to the address concerned, or to the representative once that authority is
   verified. If it can't be verified, send nothing and tell the requester why.
3. **The operator runs `pnpm admin:export`**, types the address when asked,
   then a file path outside the repository: an absolute path or one
   starting `~/` (the script runs in `backend/`, so it refuses a relative
   one), such as `~/github/pitman-private/access/<date>.json`. Name the file
   by date, not by the person. `-` prints to stdout instead. It never
   overwrites a file and writes it readable by the operator only (0600). It
   is audited as `export` before it reads anything (target: the address if
   listed, `unlisted:<hmac>` if not, as `clear-lock` does), so every export
   is on record and appears in the export itself. The profile needs auth-kit's
   `DYNAMODB_IAM_ACTIONS` on the table, `lambda:GetFunctionConfiguration`
   and `ses:GetSuppressedDestination`; without the last it still writes the
   export, with SES marked "not checked", says so and exits 1. The table's
   part comes from auth-kit's `exportAddress` (v0.3.0), which writes the
   `export` row and gathers one section per kind in its `PERSONAL_RECORDS`,
   the same list its `eraseAddress` works from; the script adds the SES
   section. The export is JSON, each section with what it is in words and
   how many were found; times are UTC ISO 8601 and audit actions are in words:

   | Section | What it holds |
   |---|---|
   | `user` | The user item: id, address, admin or not, who added them and when, when they last signed out everywhere, the delivery-problem flag |
   | `address` | The address index item (address → user id) |
   | `code` | A live sign-in code's expiry and wrong tries (never its hash) |
   | `throttle` | Codes sent in the last 24 h, wrong codes in a row, the last wrong code, any lock |
   | `revokedSessions` | Sessions they signed out of (session id, refused until), from the user's session index while they are listed |
   | `auditActor` | Audit rows where they acted: sign-ins, wrong codes, user-list changes, under their address or as `unlisted:<hmac>` / `erased:<hmac>` |
   | `auditTarget` | Audit rows about them: added, made or unmade admin, removed, mail bounced or complained, flag cleared, lock cleared, an earlier export |
   | `addedBy` | Users they added (when, and whether as admin); those users' addresses withheld |
   | `sesSuppression` | SES's suppression entry: reason (`BOUNCE` / `COMPLAINT`) and when, or none |

   Another person's address in any of these (the admin who added them, a
   user they added) reads "another person (withheld)"; `operator` reads "the
   operator" and `system` "mail delivery (Amazon SES)". The export also
   lists what is *not* held: network files (they never leave the browser),
   log lines (no address), signed-out sessions of someone already removed
   from the list (a session id and a user id that no longer leads to the
   address, at most 7 days), and point-in-time recovery (35 days). auth-kit
   owns the record list and its coverage: its contract suite runs a real
   erasure over a table holding every kind and fails if erasure touches
   anything the export doesn't return. Pitman's
   `backend/scripts/export-address.test.ts` checks that every one of
   auth-kit's kinds reaches the file, then SES.
4. **Check what sits outside the table.** Nothing here should name the
   address; a hit is a bug (A-AUTH-11) to fix, and to mention in the answer.
   Read the address into a variable so it never lands in shell history:
   - **The bounce queue's DLQ** (`pitman-mail-events-dlq`, 14 days): an SES
     bounce or complaint that failed 5 times keeps SES's notification, which
     names the recipient.
     `aws sqs get-queue-attributes --queue-url "$(aws sqs get-queue-url --queue-name pitman-mail-events-dlq --region af-south-1 --profile pitman --query QueueUrl --output text)" --attribute-names ApproximateNumberOfMessages --region af-south-1 --profile pitman`
     prints how many it holds: if not 0, the DLQ alarm is already open; read the
     messages for that alarm and, if one names the address, add its event
     type and time to the answer. The main queue (4 days) is drained in
     seconds.
   - **The sign-in mail queue and its DLQ** (`pitman-mail-send`, 10
     minutes; `pitman-mail-send-dlq`, a day): a queued email holds the
     address and a code, sealed under a key derived from `AUTH_CODE_KEY`, so
     nobody reads it in the console. Nothing to search: the queue keeps an
     email only as long as its code lives, and the DLQ for a day from when it
     was sent. Mention in the answer that a code requested in the last day
     may still sit there, sealed, until it expires.
   - **The Lambda's logs** (`/aws/lambda/pitman-backend`, 30 days):
     `read -r A && aws logs filter-log-events --log-group-name /aws/lambda/pitman-backend --filter-pattern "\"$A\"" --region af-south-1 --profile pitman --query 'length(events)'`
     prints how many lines hold the address (expected 0) without printing
     any of them.
   - **SES** keeps nothing else per recipient for Pitman: the configuration
     set publishes only bounces and complaints, to SNS → SQS (`infra/ses.tf`).
   Not yet checked (no account, #22): whether CloudTrail records the address
   as a request parameter of `GetSuppressedDestination` or of the log
   search; check it at the first access request and note the answer here
   and in § Erasure.
5. **Send it** to the verified address (or verified representative): the
   export file, and a short cover note saying what each section is, that
   other people's addresses are withheld, what is not held, who has or has
   had access to it (s23(1)(b); the export's `recipients` list), and that they may ask for correction
   (POPIA s23(2) requires saying so) or deletion (§ Erasure) or complain to the Information Regulator (the
   privacy notice's contacts). Then delete the operator's copy; the `export`
   audit row is the record that it was made.
6. **Record it**: the dates received, verified and answered, that steps 3
   and 4 were done, and anything found outside the table (not the address).

## Erasure

A request to erase a person's address (POPIA), in order:

1. **An admin removes the user** on the Users page (`DELETE /users/:id`),
   which deletes their user, address, code and lock items. Skip if they are
   no longer listed.
2. **The operator runs `pnpm admin:erase`** and types the address when asked.
   It removes the user if still listed (refused if they are the last admin),
   deletes the code and lock items and the user's signed-out sessions, and
   replaces the address with
   `erased:<hmac>` in every audit row and in other users' "added by". It is
   audited as `erase`. If rows naming the address keep appearing while it
   works, auth-kit stops after 5 passes and the script says "Not finished":
   run it again with the same address.
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
   no longer holds the deleted items. (A sign-in email queued in the last
   day may still sit, sealed, in `pitman-mail-send-dlq`; SQS deletes it a day
   after it was sent, well inside those 35 days.)

## Compliance drift

`.github/workflows/compliance-drift.yml` (`pnpm check:compliance`,
`scripts/ci-guards/compliance-drift.mjs`) runs on every pull request and every
push to `main` and annotates a change that should have moved this page or
`docs/data.md` and didn't:

- **outbound-host**: `backend/src`, `frontend/src` or `packages/*/src` gains
  a URL to a host that isn't local, reserved, AWS or the site, and that
  neither this page nor `docs/data.md` names. A data source goes in
  `docs/data.md`; a host that receives personal data is a sub-processor and
  goes here.
- **sdk-dependency**: a `package.json` gains an analytics, telemetry or
  other third-party SDK this page doesn't name.
- **pii-field**: the sign-in code (`backend/src/auth`, `backend/scripts`,
  `infra/users.tf`) gains a personal-data-shaped identifier (a phone number,
  a display name, a user agent, …) this page doesn't name.
- **auth-kit-bump**: the `@absence0760/auth-kit` pin moves. auth-kit owns the
  user record and the audit rows, so check its changelog for new stored or
  logged personal data and update § Users and sign-in.

It warns and never fails, and isn't in the CI gate; the workflow's header
records what it found over the history when it was introduced.

## Incident playbook

1. **Suspected secret leak** — rotate at the source dashboard, update
   `../infra-secrets/<project-slug>/prod.sops.yaml` (`sops`), run `terraform apply`.
2. **IAM credential leaked** — deactivate immediately, check CloudTrail,
   rotate all secrets if `kms:Decrypt` was available.
3. **AWS account compromised** — full account recovery, rotate everything,
   re-provision infrastructure.
4. **Someone is locked out of sign-in** (an `auth.locked` or
   `auth.send_capped` alarm, or a user reports it) — `pnpm admin:clear-lock` clears the lock without changing
   their role; `pnpm admin:recover` also makes them an admin (the way back in
   when no admin can sign in). Both are audited.
5. **A session or an admin's mailbox is compromised** — another admin removes
   or demotes the user (it bites on their next request); the user can also
   use "sign out everywhere". Rotating `AUTH_SESSION_KEY`
   (`terraform apply -replace`) signs everyone out.
6. **Runaway spend** (a `pitman-breaker-*`, `pitman-lambda-invocations`,
   `-lambda-throttles`, `-cloudfront-requests`, `-cloudfront-bytes`,
   `-route53-queries` or `-usage-table-throttles` alarm, or a budget or
   cost-anomaly mail, which reports spend up to a day old).
   At the hard caps a flood costs $458 a month in Lambda compute plus $70 in
   requests, ~$74 in logs and $44 in the user table (`infra/README.md` §
   Cost); one signed-in user is also bounded by the daily per-user quota
   (R4-D7: about $0.60 a day, $18 a month), and CloudFront and Route 53
   have no cap at all on pay-as-you-go ($173 a day at 1 000 requests a second).
   - **The breaker has tripped** (`pitman-breaker-api-concurrency`,
     `-api-duration` or `-api-invocations` in ALARM, and
     `{"event":"breaker.tripped",…}` in `/aws/lambda/pitman-breaker`): the
     API's reserved concurrency is 0, so no copy runs, nothing is billed at
     the Lambda and nothing reads IC-WBT's buckets. The API answers 429
     (throttled), sign-in mail waits on its queue and is dropped once its
     code expires (so nobody can sign in), bounces wait on theirs and may
     dead-letter, and the static site stays up. Find the cause first (the
     Lambda's logs, the CloudFront and WAF metrics; sampled requests are
     off), then reset with **`pnpm infra:breaker-reset pitman`**
     (`infra/scripts/breaker-reset.sh`). The trips are alarm actions, which
     fire only on a transition into ALARM, so an alarm left in ALARM can't
     trip again; the script puts every `pitman-breaker-api-*` alarm back to
     OK (re-arming them: if the flood is still on, the next evaluation goes
     back to ALARM and trips again), restores the reserved concurrency to
     `lambda_reserved_concurrency`, and redrives `pitman-mail-events-dlq`
     (the bounces that dead-lettered meanwhile). It refuses while the current
     clock hour's Duration is already over the Duration trip, since that
     alarm would re-trip at once on the load that tripped it; wait for the
     hour to turn, or set `BREAKER_RESET_NOW=1`. **A plain `terraform apply`
     during an incident re-opens the API** (it restores the reserved
     concurrency) **but leaves the alarms in ALARM, so the breaker stays
     unarmed** until they return to OK on their own (up to 15 minutes of
     quiet, or the rest of the clock hour for the Duration trip); run the
     script instead, or after. The deploy role can't undo a trip.
   - **The breaker failed** (`pitman-breaker-errors`) or the spend is one it
     doesn't see (the edge, DNS): the manual kill switches, each one
     command:
   - **API (Lambda):** `aws lambda put-function-concurrency --function-name pitman-backend --reserved-concurrent-executions 0 --region af-south-1 --profile pitman`.
     The same effect as a trip. Put it back deliberately, after the cause is
     fixed, with `pnpm infra:breaker-reset pitman` (a `terraform apply` also
     restores it).
   - **Edge (CloudFront):** first tighten the WAF: lower
     `waf_site_rate_limit_per_ip` (and `waf_api_rate_limit_per_ip`) in
     `infra/terraform.tfvars` and plan and apply (the minimum is 100 per 5
     minutes). If the flood is spread too thin for per-IP limits, disable
     the distribution, which stops all edge spend and takes the whole site
     down. With the distribution ID (`gh variable get CLOUDFRONT_DISTRIBUTION_ID --repo Absence0760/pitman`) as `<id>`, three commands:
     `aws cloudfront get-distribution-config --id <id> --profile pitman > dist.json`, then
     `jq '.DistributionConfig.Enabled = false | .DistributionConfig' dist.json > disabled.json`, then
     `aws cloudfront update-distribution --id <id> --if-match "$(jq -r .ETag dist.json)" --distribution-config file://disabled.json --profile pitman`.
     Terraform sees the drift; the next apply re-enables it.
   Then find the source in the CloudFront and WAF metrics (sampled requests
   are off, waf.tf) and the Lambda's logs before turning anything back on.

## Known gaps

- The WAF limits are per IP; a flood spread over many addresses is bounded by
  reserved concurrency at the Lambda, stopped by the breaker if it keeps the
  copies busy or sends more than 10 requests a second for 15 minutes, and
  surfaced by the invocation alarm, not blocked. Below the invocations trip
  a fast-request flood can still run $7 of Lambda requests and ~$7.40 of
  log lines a month, mailed within 5 minutes. A tripped API still costs at
  the edge: CloudFront and the WAF bill every request it answers 429 to. At
  the edge and in DNS nothing bounds it: the CloudFront requests and bytes and
  Route 53 query alarms say so within about 5-10 minutes, and the kill
  switch (§ Incident playbook) is manual. CloudFront's flat-rate Pro plan
  would make both fixed costs ($15 a month, no overage, WAF-blocked requests
  not counted); it is wired but off (`cloudfront_flat_rate_plan = "none"`,
  `infra/pricing_plan.tf`), and turning it on is the operator's decision:
  the subscription waits unbilled for their approval in the console, and
  whether AWS accepts the `/api/*` origin (a Lambda Function URL behind a
  `lambda` OAC, with a custom origin header) is unconfirmed until it is
  tried (R4-I15, `docs/deployment.md` § Then: the flat-rate plan).
- The CloudFront shared secret, the two sign-in keys (`AUTH_CODE_KEY`,
  `AUTH_SESSION_KEY`) and, once set, the Cape Farm Mapper token
  (`CFM_TOKEN`, from the `cfm_token` variable; R7-C9, issue #22 decision 15
  still open) sit in the Lambda's environment and the Terraform state (both
  in-account, encrypted at rest), not Secrets Manager. Anyone who
  can read the function's configuration can mint a session (A-AUTH-8 accepts
  this; the account is the root of trust).
- **Read-only access to the Lambda is admin access.** Anyone who can call
  `lambda:GetFunctionConfiguration` on the API function, which AWS's
  `ReadOnlyAccess` and `ViewOnlyAccess`-style policies include, reads
  `AUTH_SESSION_KEY` and can mint an admin session. Treat every read-only
  permission set in the pitman account as admin-equivalent; the same accepted
  gap as A-AUTH-8. The durable fix, if the account ever gains read-only
  users, is SSM SecureString or Secrets Manager under a CMK (a cold-start
  fetch, about $0.40-$1/month).
- A flood spread over many IPs that holds every reserved Lambda copy busy
  also throttles both queues' polls. After 5 receives a bounce or complaint
  dead-letters (SES has still suppressed the address) and the DLQ alarm
  fires; redrive after the flood. Sign-in email waits on its queue (the
  mail-send age alarm fires at 2 minutes) and is deleted unsent once its code
  has expired, so nobody can sign in until the flood ends. The durable fix,
  if it ever bites, is a separate small function for the queues, with its
  own reserved concurrency.
- Dependency scanning is weekly, not per change: `.github/workflows/audit.yml`
  runs `pnpm audit --audit-level=moderate` every Monday and opens a
  `dependency-audit` issue (closed by the next clean run), and Dependabot
  raises update PRs. Low-severity findings are not reported.
