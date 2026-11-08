# Deployment

Pitman runs at **`https://pitman.jaredhoward.com`**: one CloudFront
distribution serving the static SvelteKit site from a private S3 bucket and
proxying `/api/*` to the Hono API on AWS Lambda, in Pitman's own AWS account
(issue #22 step 4). The Lambda and the bucket are in **`af-south-1`** (D-6),
beside IC-WBT's buckets it reads; CloudFront, its certificate and its WAF are
global / `us-east-1`. The Terraform is in `infra/` (`infra/README.md` lists
the files); CI deploys with GitHub OIDC, never static keys.

```
browser ──► CloudFront (WAF, CSP headers, pitman.jaredhoward.com)
              ├─ /*      ─► S3 site bucket (OAC; client routes → index.html)
              └─ /api/*  ─► strip /api ─► Lambda Function URL (AWS_IAM: OAC-signed, + shared-secret header)
                                            ├─► IC-WBT's buckets, read-only (CHIRPS rnl/*, MAP grid)
                                            ├─► DynamoDB pitman-users (the user list, #28)
                                            └─► SQS pitman-mail-send: one sealed sign-in email per code request (#30)
SQS pitman-mail-send ─► the same Lambda ─► SES: sign-in codes from no-reply@pitman.jaredhoward.com
SES bounces/complaints ─► SNS pitman-ses-events ─► SQS pitman-mail-events ─► the same Lambda
```

## How a deploy happens

Two workflows, each **gate** (decides, no secrets), **build** (no AWS
access) then **deploy** (gated on the `production` GitHub environment, so a
required reviewer approves every run; only that job can mint an OIDC token,
and the deploy role's trust policy only accepts tokens for that environment).

**A deploy runs only after CI has passed on the commit it ships.** Neither
workflow triggers on `push`: each triggers on `workflow_run` of CI, and its
gate job runs only when that CI run succeeded, was a push (not a pull
request, not a fork) and was on `main` in this repository. The gate checks
out exactly the commit CI tested (`workflow_run.head_sha`) and the build
uses that commit too, so a red CI run never reaches the approval prompt.

The gate (`scripts/deploy/deploy-gate.mjs`, tested in
`scripts/deploy/deploy-gate.test.mjs`) then deploys only if a file under the
workflow's `DEPLOY_PATHS` changed between **the commit the last successful
deploy job shipped** and this one. Not against the push's before-SHA: CI
cancels a superseded run on `main`, and the reviewer may reject a deploy, so
the previous commit isn't necessarily what is live; comparing with what is
live means a burst of pushes, a cancelled CI run or a rejected approval
never drops a change. Each run records its commit in its run-name
(`Deploy backend <sha>`), which is how the gate reads that commit back. It
never deploys a commit older than the live one (roll back by reverting on
`main`), and deploys if nothing was ever deployed (the Terraform stub is
live).

| Workflow | Deploys when these changed | Build | Deploy |
|---|---|---|---|
| `deploy-frontend.yml` | `frontend/`, `packages/wrsm/`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `infra/csp.json`, `infra/scripts/check-csp.mjs` or itself | `pnpm build`, then `infra/scripts/check-csp.mjs` (refuses a build whose inline scripts aren't hashed in SvelteKit's meta CSP, or with an inline style the header doesn't allow) | sync `_app/immutable/` (1-year immutable cache; old hashed files kept for open tabs), sync the rest with `--delete` (60 s cache), invalidate `/*` and wait |
| `deploy-backend.yml` | `backend/`, `packages/wrsm/`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (auth-kit's `onlyBuiltDependencies` line) or itself | typecheck, esbuild bundle, zip | `update-function-code`, wait, then `GET /api/health` through CloudFront |

**Until the operator wires CI, both are inert:** every job's `if:` needs the
repo variables below, so before they exist each run shows *skipped*, not
failed. Terraform owns the Lambda's configuration (memory, timeout,
concurrency, environment); the workflow only ever replaces its code.

Manual run: `gh workflow run deploy-backend.yml` / `gh workflow run deploy-frontend.yml`, then approve it in the Actions tab. A manual run always deploys (whatever changed), but the gate refuses it unless it runs from `main` and CI has a successful run on that commit.

`scripts/ci-guards/workflows.test.mjs` pins the trigger, the gate's
conditions, the commit each job checks out and the path lists.

### GitHub repo variables

All set in one go by `~/github/templates/scripts/export-tf-vars.sh infra/`
from the Terraform outputs (each output's name, uppercased; `infra/outputs.tf`).
None is a secret; the repo needs no AWS secret at all. No output is marked
`sensitive`, because the script would push a sensitive one as a GitHub
*secret* nobody reads; so the bare Function URL is not an output (step 53
reads it with the AWS CLI).

| Variable | Output | Used by |
|---|---|---|
| `AWS_DEPLOY_ROLE_ARN` | `aws_deploy_role_arn` (the bootstrap's `pitman-deploy` role) | both: `role-to-assume` |
| `AWS_REGION` | `aws_region` (`af-south-1`) | both |
| `FRONTEND_BUCKET` | `frontend_bucket` (`pitman-frontend-<account>`) | frontend |
| `CLOUDFRONT_DISTRIBUTION_ID` | `cloudfront_distribution_id` | frontend |
| `LAMBDA_FUNCTION_NAME` | `lambda_function_name` (`pitman-backend`) | backend |
| `PUBLIC_API_URL` | `public_api_url` (`https://pitman.jaredhoward.com/api`) | frontend build env |
| `PUBLIC_SITE_URL` | `public_site_url` | backend smoke check (the frontend build reads no site URL) |
| `CLOUDFRONT_DOMAIN_NAME`, `CLOUDFRONT_DISTRIBUTION_ARN`, `LAMBDA_ROLE_ARN` | the outputs of the same names | no workflow; exported because every output is (the ARNs are for IC-WBT's bucket policies, the domain for checks before DNS) |

The role ARN is a *variable*, not a secret, on purpose: a job-level `if:`
can read variables but not secrets, which is what keeps the workflows inert
until it's set; an ARN grants nothing by itself (assuming the role needs this
repo's `production` OIDC token, which needs the reviewer). It is not
masked in logs; AWS does not treat account IDs as secret.

### Lambda environment

Set by Terraform (`infra/lambda.tf`), never by CI. The names match what
`backend/src` reads.

| Name | Value | Meaning |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://pitman.jaredhoward.com` | Hono `cors()` allow-list (every request is same-origin anyway) |
| `SITE_URL` | `https://pitman.jaredhoward.com` | the site's URL |
| `CLOUDFRONT_SHARED_SECRET` | generated by Terraform | the app rejects any request without CloudFront's `X-CloudFront-Shared-Secret` header (in Terraform state only); unset or empty on Lambda, every request is 503. The second lock behind the OAC (§ Lambda origin access control) |
| `CHIRPS_SOURCE` | `s3` once the CHIRPS grant is configured, else empty | where the CHIRPS reader reads (`s3` = IC-WBT's mirror bucket; empty = feature unavailable) |
| `CHIRPS_BUCKET` | `chirps_bucket` | IC-WBT's mirror bucket |
| `CHIRPS_PREFIX` | `chirps_prefix` (`rnl`) | the store's prefix in it |
| `MAP_GRID_SOURCE` | `s3://<map_grid_bucket>/<map_grid_key>`, or empty | the MAP grid (method B) |
| `DATA_REGION` | `icwbt_region` (`af-south-1`) | region for the S3 client that reads IC-WBT's buckets, wherever Pitman itself runs (pass it explicitly; `docs/data.md`) |
| `USER_STORE` | `dynamodb` | auth-kit's store (#28; locally a dev store) |
| `USERS_TABLE` | `pitman-users` | the user table (`infra/users.tf`) |
| `AUTH_CODE_KEY` | generated by Terraform (`random_password.auth_code_key`, 48 characters) | HMAC key for sign-in codes and the address-keyed `CODE#`/`THROTTLE#` items (A-AUTH-8; Terraform state only) |
| `AUTH_SESSION_KEY` | generated by Terraform (`random_password.auth_session_key`, 48 characters, a different value) | session JWT signing key (A-AUTH-3, A-AUTH-8; Terraform state only) |
| `MAIL_TRANSPORT` | `ses` | send through SES v2 with the function's own role (no SMTP password) |
| `MAIL_FROM` | `no-reply@pitman.jaredhoward.com` | the only From address the role may send as (`ses:FromAddress` condition) |
| `SES_CONFIGURATION_SET` | `pitman` | the configuration set every message must name (TLS required, suppression, events) |
| `MAIL_QUEUE` | `sqs` | `POST /auth/code` enqueues the sign-in email rather than sending it (#30, A-AUTH-14) |
| `MAIL_QUEUE_URL` | the `pitman-mail-send` queue's URL (`infra/mail_queue.tf`) | where it enqueues; `lambda.ts` also sends this queue's batches to the mail worker |
| `USAGE_STORE` | `dynamodb` | where the per-user daily quotas are counted (R4-D7, R4-I9). Without it (and `USAGE_TABLE`) on Lambda, `/chirps`, `/delineate`, `/channels` and `/cfm` answer 503 |
| `USAGE_TABLE` | `pitman-usage` (`infra/usage.tf`) | the usage table: hash key `pk`, TTL on `expires_at`; the role may only `UpdateItem` it |
| `CFM_SOURCE` | `cfm` when `cfm_token` is set, else empty | Cape Farm Mapper's source (`backend/src/cfm/source.ts`; empty = `/cfm` answers 503) |
| `CFM_TOKEN` | `cfm_token` (sensitive; empty by default) | the operator's Cape Farm Mapper token (D3, R7-C9), below |
| `CFM_CROPS_LAYER_URL` / `CFM_DAMS_LAYER_URL` | `cfm_crops_layer_url` / `cfm_dams_layer_url` (https only; crops required with a token) | the layers the token reads |

**The Cape Farm Mapper token comes in through Terraform.** Terraform owns
this whole environment block, so a token set by hand in the console would be
wiped by the next apply. It lives in the operator's sops file
(`../infra-secrets/pitman/prod.sops.yaml`, under a key such as `cfm_token`) and reaches the
plan by **decrypt-to-tfvars**, on the operator's machine only: write a
gitignored `infra/cfm.auto.tfvars` (`*.tfvars` is ignored) holding
`cfm_token = "…"` from `sops -d --extract '["cfm_token"]' ../infra-secrets/pitman/prod.sops.yaml`,
plan and apply, then `rm infra/cfm.auto.tfvars infra/tfplan`. The token then
sits in the Terraform state and the function's configuration, like the
sign-in keys (`docs/security.md` § Known gaps). This replaces nothing yet:
**issue #22 decision 15 (Secrets Manager, R7-C9) is still open**, and if it
goes that way the function reads the token at start-up and `cfm_token` goes.

**Not set yet, so those routes answer 503 by design** (not a failed deploy):
`QUATERNARIES_SOURCE` (the quaternary catalogue, `/quaternaries`, until
Pitman's own bucket exists, D-1), `DEM_SOURCE` (delineation and channels,
until Round 5's DEM grant), `CFM_SOURCE` / `CFM_TOKEN` (Cape Farm Mapper land
use, `/cfm`, until `cfm_token` is set, above, D3), and, until IC-WBT's grants
(§ Then: IC-WBT's data), `CHIRPS_SOURCE` and `MAP_GRID_SOURCE`
(`/chirps`, `/map-grid`). Each answers 503 with a "not configured" message
to a signed-in user; anonymous callers get 401 first.

The function has two more triggers besides the Function URL, both SQS
event source mappings (batches of up to 10, at most 2 at once,
`ReportBatchItemFailures`): `pitman-mail-send` delivers the sign-in emails
`POST /auth/code` enqueued (no batching window; the mail worker sends them,
#30), and `pitman-mail-events` delivers SES bounces and complaints (a 5 s
window). `backend/src/lambda.ts` tells an SQS batch from an HTTP request, and
the mail queue's batches (by source ARN, against `MAIL_QUEUE_URL`) from the
bounce queue's. The SES and SQS region is the function's own (`AWS_REGION`,
af-south-1).

Logs are JSON (`infra/lambda.tf`): application lines at `INFO` and above
(everything the backend writes; the log-line alarms read them), platform
lines at `WARN` and above (no START/END/REPORT per invocation).

**The spend breaker can set the function's reserved concurrency to 0**
(`infra/breaker.tf`, R4-I7): when 6 or more copies run in each of three
5-minute periods, more than 7 200 000 ms run in an hour, or more than 3 000
invocations run in each of three 5-minute periods. The API then answers 429
and sign-in stops until it is reset. Find the cause first
(`docs/security.md` § Incident playbook), then:

- **Reset with `pnpm infra:breaker-reset pitman`** (`infra/scripts/breaker-reset.sh`;
  the argument is the AWS profile). It puts every `pitman-breaker-api-*`
  alarm back to OK, restores the reserved concurrency to
  `lambda_reserved_concurrency` (read from `infra/terraform.tfvars`, else
  10), and redrives `pitman-mail-events-dlq` into its queue with
  `aws sqs start-message-move-task` (bounces and complaints that
  dead-lettered while the mapping was throttled). It doesn't redrive the
  sign-in mail DLQ: those codes have expired. It refuses while the current
  clock hour's Duration is already over the Duration trip, because that
  alarm would re-trip at once; wait for the hour to turn (UTC) or set
  `BREAKER_RESET_NOW=1`.
- **Why not just `terraform apply`:** a trip fires only when an alarm moves
  into ALARM. A routine `terraform apply` during an incident re-opens the API
  (the function owns `reserved_concurrent_executions`, so the breaker's 0 is
  a one-line in-place change) but doesn't touch the alarms, which stay in
  ALARM and can't trip again until they have gone back to OK by themselves.
  Run the script after any such apply.
- The deploy role can't change concurrency, so a deploy never resets it.

Sign-in's variables (`backend/src/auth/config.ts`). **Until they are all
set, every route but `/health` and `POST /auth/logout` answers 503** (fail
closed), and the Lambda logs `{"event":"auth.unconfigured","problem":…}`
naming the gap, never a value.

| Name | Value | Meaning |
|---|---|---|
| `USER_STORE` | `dynamodb` | auth-kit's DynamoDB store (`memory` is refused on Lambda) |
| `USERS_TABLE` | the `pitman-users` table's name | the user table (pk/sk, TTL on `ttl`, PITR, deletion protection) |
| `AUTH_CODE_KEY` | Terraform `random_password`, 32+ characters | keys the code and address HMACs |
| `AUTH_SESSION_KEY` | another `random_password`, 32+ characters, different | signs session tokens (kid `k1`) |
| `MAIL_TRANSPORT` | `ses` | `console` and `smtp` are refused on Lambda |
| `MAIL_FROM` | the bare address `no-reply@pitman.jaredhoward.com` (Terraform sets no display name; the local dev default is `Pitman <no-reply@localhost>`) | the sign-in email's From |
| `SES_CONFIGURATION_SET` | the configuration set's name | TLS-required delivery, suppression and bounce/complaint events |
| `MAIL_QUEUE` | `sqs` | `inline` (local dev's in-process queue) is refused on Lambda |
| `MAIL_QUEUE_URL` | the mail queue's URL, `https://sqs.<region>.amazonaws.com/<account>/<name>` | where sign-in email is enqueued |

`DYNAMODB_ENDPOINT` and `AUTH_DEV_COOKIE` are for local dev and are refused
on Lambda.

The API routes are mounted **without** the `/api` prefix: CloudFront's
`api_strip_prefix` function turns `/api/chirps/monthly` into
`/chirps/monthly` before the Lambda sees it, as in local dev where the
frontend calls `:3001` directly.

### Lambda origin access control

The Function URL is `AWS_IAM` (issue #33, decision R4-I6). CloudFront signs
every `/api/*` request to it with SigV4 through the `pitman-api-oac` origin
access control, and the function's resource policy lets
`cloudfront.amazonaws.com` invoke it only on behalf of this distribution:
`lambda:InvokeFunctionUrl` (statement `AllowCloudFrontServicePrincipal`) and,
as every Function URL has needed since October 2025, `lambda:InvokeFunction`
(`AllowCloudFrontServicePrincipalInvokeFunction`), both in
`infra/s3_cloudfront.tf`. A request that skips CloudFront is unsigned, so
Lambda's front end answers it `403` with the body `{"Message":"Forbidden"}`
before the function runs: no invocation, no bill, no log line. (AWS documents
the 403, not that body; the body is what an unsigned call to an `AWS_IAM`
URL returns in practice. The app's own refusal, `{"error":"forbidden"}`,
means a request reached the function, which a direct call no longer can.)

Two things follow:

- **Bodies carry their hash.** CloudFront can't hash a body: it signs the
  hash the viewer states in `x-amz-content-sha256`, and Lambda refuses an
  unsigned payload. So the frontend sends the hex SHA-256 of the exact body
  on every request but GET and HEAD (`frontend/src/lib/api/content-hash.ts`;
  every API client fetches through it). Any other client of `/api/*` (a
  script, `curl`) must do the same, or its POST is `403 {"Message":"Forbidden"}`
  from Lambda. Locally there is no CloudFront and the dev server ignores the
  header.
- **The resource policy holds exactly the two CloudFront statements.** The
  provider adds public-invoke statements (`FunctionURLAllowPublicAccess`,
  `FunctionURLAllowInvokeAction`) only when it creates a `NONE` URL, so a
  stack created with this change has none. A stack that was applied with the
  URL on `NONE` keeps them after the switch, because changing the type in
  place removes nothing: the first is inert under `AWS_IAM` (its condition
  is `lambda:FunctionUrlAuthType = NONE`), but remove both, once, with
  `aws lambda remove-permission --function-name pitman-backend --statement-id FunctionURLAllowPublicAccess --region af-south-1 --profile pitman`
  and the same for `FunctionURLAllowInvokeAction`. On such a stack the
  apply that switches the URL also leaves the API answering 403 for the few
  minutes CloudFront takes to deploy the OAC (the URL changes first).

## First deploy (operator runbook)

Claude prepares and checks; the operator runs every command below (they
need the operator's AWS and GitHub credentials). One step at a time, in
order: each says what to expect, and a step marked **Gate** must show that
before you go on. Run the repo commands from the root of a pitman checkout on
`main`. `pitman` is the SSO profile made in step 17.

The order is deliberate where it matters. CI must be green before anything
deploys, and before branch protection names "CI gate" as a required check;
the repo goes public only after the pnpm caches holding auth-kit are gone and
the history is clean; and the `production` environment, with you as required
reviewer, exists before the step that switches the deploy workflows on (on
GitHub Free a required reviewer needs a public repo, and a workflow that
names a missing environment creates it with no reviewer).

The AWS account (steps 12 to 19) and going public with the gates on (steps
20 to 32) don't depend on each other: do either first. Since 2026-11-07 a
PR-only `main` is wanted (`docs/decisions.md` § Repository follow-ups), so
the bootstrap's stage 4, which applies the same `production` environment and
the same branch protection as steps 27 and 31, is no longer a reason to
bootstrap while the repo is private.

### Step 0: AWS access on this workstation

Profiles as project-mgmt's runbooks set them up (`~/github/project-mgmt/docs/runbooks.md`,
Runbook A § Prerequisites and Runbook D). The SSO start URL is the AWS
access portal URL in IAM Identity Center → Settings, in `personal-mgmt`
(`us-east-1`, instance `ssoins-72234b0cbf7ee333`).

1. Add the org-root profile: `aws configure sso --profile mgmt`. Session name `personal`, the start URL above, SSO region `us-east-1`, scope `sso:account:access`; pick account `734828258077` (personal-mgmt) and `AdministratorAccess`; default region `us-east-1`. It writes `~/.aws/config` and opens a browser to approve.
2. Add the parent-zone profile: `aws configure sso --profile dns-parent`. Reuse the session `personal`; pick account `136758763748` (jaredhoward, which owns the `jaredhoward.com` zone) and `AdministratorAccess`.
3. Log in (one approval covers both profiles, which share the session): `aws sso login --profile mgmt`.
4. **Gate:** `aws sts get-caller-identity --profile mgmt --query Account --output text` → `734828258077`.
5. **Gate:** `aws sts get-caller-identity --profile dns-parent --query Account --output text` → `136758763748`.

### CI access to auth-kit, and CI green

6. Get the auth-kit read token. **One token serves pitman and ewr-compliance**, and Absence0760/auth-kit#2 is the single procedure. If ewr-compliance already made it, take it from Bitwarden (**"GitHub token: auth-kit read"**) and skip to step 7. Otherwise create it as auth-kit#2 says, at https://github.com/settings/personal-access-tokens/new: name `auth-kit read (CI + Dependabot)`, resource owner `Absence0760`, only `Absence0760/auth-kit`, Contents: Read-only and nothing else, expiry about a year out. Save it in Bitwarden under that name with the expiry date, and set a reminder to rotate it two weeks before.
7. Store it as an Actions secret (paste at the hidden prompt): `gh secret set AUTH_KIT_READ_TOKEN --app actions --repo Absence0760/pitman`.
8. Store it as a Dependabot secret too: `gh secret set AUTH_KIT_READ_TOKEN --app dependabot --repo Absence0760/pitman`.
9. Check both exist (names only): `gh secret list --app actions --repo Absence0760/pitman && gh secret list --app dependabot --repo Absence0760/pitman` → `AUTH_KIT_READ_TOKEN` in each. Tick pitman's two secret boxes on auth-kit#2. **Rotating** (before the expiry, or at once on a suspected leak) follows auth-kit#2: a new token, set in all four secrets across both repos (these two commands here, the same pair for `Absence0760/ewr-compliance`), check, then delete the old token on GitHub and update Bitwarden. On a leak, revoke the old token first: CI fails until the new one is set, which is the safe way round.
10. Re-run CI on main: `gh workflow run ci.yml --repo Absence0760/pitman --ref main`.
11. **Gate:** after about ten minutes, `gh run list --workflow ci.yml --branch main --limit 1 --repo Absence0760/pitman --json headSha,status,conclusion` → `completed`, `success`. Red: fix it before anything else; no deploy can run on a red commit.

### The AWS account

12. Read the bootstrap's project file (committed and pushed in infra-secrets; settings, not secrets): `cat ~/github/infra-secrets/pitman/bootstrap.tfvars` → `project = "pitman"`, `account_name = "Pitman"`, `region = "us-east-1"` (the tfstate bucket and `alias/pitman-sops`; `af-south-1` isn't enabled in a new account yet, R4-I3), `create_subdomain = true`, `parent_domain = "jaredhoward.com"`, `github_repo = "Absence0760/pitman"`, `github_environment = "production"`, and `github_subject_prefix = "repo:Absence0760@21693150/pitman@1437736870"`.
13. **Gate:** the subject prefix matches what GitHub puts in this repo's OIDC tokens: `gh api repos/Absence0760/pitman/actions/oidc/customization/sub --jq .sub_claim_prefix` → `repo:Absence0760@21693150/pitman@1437736870`, exactly as in step 12. This repo uses immutable subject claims (owner and repo each with its numeric ID); a plain `repo:Absence0760/pitman` would never match, and the first deploy would fail `AssumeRoleWithWebIdentity` without naming either subject (project-mgmt Runbook G).
14. Dry-run the bootstrap: `cd ~/github/templates && ./scripts/new-project-account.sh pitman --plan`. Expect stage 1's plan only: one `aws_organizations_account` named `Pitman` to add, nothing to change or destroy. Read it: creating an account can't be undone.
15. Run it: `cd ~/github/templates && ./scripts/new-project-account.sh pitman`. Stages 1 to 3 create the account, the baseline (tfstate bucket, `alias/pitman-sops`, the GitHub OIDC provider and the `pitman-deploy` role, the `pitman.jaredhoward.com` zone) and the delegation in `jaredhoward.com`. Note the **account id** and the **tfstate bucket** from its summary. Stage 4 sets up the GitHub side: on a private repo it prints two warnings (the environment PUT and branch protection both need a public repo on GitHub Free), expected, steps 27 and 31 do both once the repo is public; on a public repo it applies them itself, the same environment and the same protection, "CI gate" included (it finds ci.yml's `pull_request` trigger and `CI gate` job). If stage 2 fails with `NotSignedUp`, `SubscriptionRequiredException` or `OptInRequired`, the new account's services are still activating: wait a few minutes and run the same command again. The script is idempotent and safe to run again at any time; on a public repo run it only while CI is green on `main`, for step 29's reason.
16. Give yourself access (Runbook D, console): in `personal-mgmt`, IAM Identity Center → AWS accounts → `Pitman` → Assign users or groups → user `Jared` → permission set `AdministratorAccess`.
17. Add the profile: `aws configure sso --profile pitman`. Reuse the session `personal`; pick the `Pitman` account and `AdministratorAccess`; default region `af-south-1`.
18. **Gate:** `aws sts get-caller-identity --profile pitman --query Account --output text` → the account id from step 15.
19. Check the child zone is delegated: `dig +short NS pitman.jaredhoward.com` → four `awsdns` servers (minutes after step 15).

### Going public, then the gates

20. **Gate:** no workflow on `main` caches the pnpm store any more (it would hold auth-kit's code): `git fetch origin && git grep -nE '^[[:space:]]*cache:' origin/main -- .github/workflows/` → no output.
21. Delete the caches saved before that change: `gh cache delete --all --repo Absence0760/pitman`.
22. **Gate:** `gh cache list --repo Absence0760/pitman` → nothing listed.
23. **Gate:** no client term anywhere in the history (needs `~/github/infra-secrets/pitman/client-terms.txt`; `docs/security.md` § Public repo hygiene): `pnpm check:terms --history` → `Client terms OK (the history of every ref).` A "No client terms file" line means it checked nothing: fix the file first.
24. Run the full-history secret scan: `gh workflow run gitleaks-sweep.yml --repo Absence0760/pitman --ref main`.
25. **Gate:** `gh run list --workflow gitleaks-sweep.yml --limit 1 --repo Absence0760/pitman --json status,conclusion` → `completed`, `success`. A finding: rotate the secret and clean the history before going on.
26. Make the repo public: `gh repo edit Absence0760/pitman --visibility public --accept-visibility-change-consequences`.
27. Create the environment with you as required reviewer: `~/github/templates/scripts/backfill-prod-environment.sh --apply Absence0760/pitman` → `FIXED (MISSING -> required reviewer = <your login>)`, or `OK (required reviewer already set)` if the bootstrap's stage 4 ran on the public repo first.
28. **Gate:** `gh api repos/Absence0760/pitman/environments/production --jq '.protection_rules[] | select(.type=="required_reviewers") | .reviewers[].reviewer.login'` → your login. Then restrict which refs may deploy to it, so a manual run from an unmerged branch can't reach production with only your approval (the deploy gate script refuses one already; this is GitHub's own layer, independent of the workflow code): turn custom branch policies on while keeping the reviewer, `printf '{"wait_timer":0,"prevent_self_review":false,"reviewers":[{"type":"User","id":%s}],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' "$(gh api user --jq .id)" | gh api -X PUT repos/Absence0760/pitman/environments/production --input -`, add `main`, `gh api -X POST repos/Absence0760/pitman/environments/production/deployment-branch-policies -f name=main -f type=branch`, and check: `gh api repos/Absence0760/pitman/environments/production/deployment-branch-policies --jq '.branch_policies[]|"\(.type) \(.name)"'` → `branch main`, with the reviewer check above still printing your login. Both estate scripts keep this policy when they re-assert the reviewer (templates#11); re-run both checks after any rerun of `new-project-account.sh` or `backfill-prod-environment.sh` anyway, since the policy is what keeps an unmerged branch out of production. Don't reach step 47 without both.
29. **Gate:** CI is green on `main`'s head right now (`main` has moved since step 11): `gh run list --workflow ci.yml --branch main --limit 1 --repo Absence0760/pitman --json headSha,status,conclusion` → `completed`, `success`, with `headSha` equal to what `git fetch origin && git rev-parse origin/main` prints. Red or still running: wait for it or fix it first. Step 31 makes "CI gate" required and enforces it on admins, and every PR is tested on its merge with `main`: with a red `main` no PR could merge, not even the fix, and nobody can push past it.
30. Merge settings to match the protection: `gh repo edit Absence0760/pitman --enable-merge-commit=false --enable-squash-merge --enable-rebase-merge --enable-auto-merge --delete-branch-on-merge`. Linear history refuses merge commits, so squash and rebase are the two merge buttons left; auto-merge is what `dependabot-auto-merge.yml` queues (`gh pr merge --auto --squash`).
31. Protect `main` in the estate's standard posture, the payload of `new-project-account.sh` stage 4b with "CI gate" as the one required check: PR required and enforced on admins, 0 approvals (you can't approve your own PR, so the green check is the merge gate), linear history, no force-push or deletion, conversations resolved before merge: `echo '{"required_status_checks":{"strict":false,"contexts":["CI gate"]},"enforce_admins":true,"required_pull_request_reviews":{"required_approving_review_count":0,"dismiss_stale_reviews":true,"require_code_owner_reviews":false,"require_last_push_approval":false},"restrictions":null,"required_linear_history":true,"allow_force_pushes":false,"allow_deletions":false,"required_conversation_resolution":true,"lock_branch":false,"allow_fork_syncing":false}' | gh api -X PUT repos/Absence0760/pitman/branches/main/protection -H "Accept: application/vnd.github+json" --input -` → the protection back as JSON, no error. Never apply it without the required check, even for a moment: with no required check a PR is mergeable the instant it's opened, so the auto-merge `dependabot-auto-merge.yml` queues would land every minor and patch bump without CI having run.
32. **Gate:** `gh api repos/Absence0760/pitman/branches/main/protection --jq '[.required_status_checks.contexts, .enforce_admins.enabled, .required_pull_request_reviews.required_approving_review_count, .required_linear_history.enabled, .allow_force_pushes.enabled, .allow_deletions.enabled, .required_conversation_resolution.enabled]'` → `[["CI gate"],true,0,true,false,false,true]`. From here every change reaches `main` through a pull request (`CLAUDE.md` § Working alongside other Claude sessions).

### Region, quota and billing

33. Enable `af-south-1` in the account: `aws account enable-region --region-name af-south-1 --region us-east-1 --profile pitman`.
34. **Gate:** wait until it reports `ENABLED` (minutes, sometimes hours): `aws account get-region-opt-status --region-name af-south-1 --region us-east-1 --profile pitman --query RegionOptStatus --output text`.
35. Check the Lambda concurrency quota (must be at least `lambda_reserved_concurrency` + the breaker's 1 + 10 = 21): `aws service-quotas get-service-quota --service-code lambda --quota-code L-B99A9384 --region af-south-1 --profile pitman --query Quota.Value`. A `NoSuchResourceException` means the quota has never been touched: read the default instead with `aws service-quotas get-aws-default-service-quota --service-code lambda --quota-code L-B99A9384 --region af-south-1 --profile pitman --query Quota.Value`.
36. If it's below 21, ask for 1 000 (usually granted automatically, can take a day): `aws service-quotas request-service-quota-increase --service-code lambda --quota-code L-B99A9384 --desired-value 1000 --region af-south-1 --profile pitman`.
37. Check whether the org manages root centrally: `aws iam list-organizations-features --profile mgmt --query EnabledFeatures`. The budget (`infra/alarms.tf`) can't be created until **IAM access to billing information** is on in the account, a root-only toggle, and an account the org created has no root password.
38. Turn billing access on, or take the explicit opt-out:
    - **If step 37 lists neither `RootCredentialsManagement` nor `RootSessions`:** open the root sign-in page (signin.aws.amazon.com, "Root user"), enter the `account_email` from step 12, choose "Forgot password", set a strong password from the reset mail (keep it in Bitwarden), sign in, add MFA, then Account → "IAM user and role access to Billing information" → Edit → Activate. Sign out of root.
    - **If root is managed centrally, or you'd rather not touch root yet:** in step 40 set `budget_monthly_usd = 0` **and** `no_budget_acknowledged = true` (Terraform refuses 0 without it). The CloudWatch alarms still run. Come back later: enable billing access, set the budget, remove the opt-out, plan and apply.

### Terraform

39. Write the backend config, with the tfstate bucket from step 15 and region `us-east-1`: `cp infra/backend.config.example infra/backend.config && $EDITOR infra/backend.config`.
40. Write the variables: `cp infra/terraform.tfvars.example infra/terraform.tfvars && $EDITOR infra/terraform.tfvars`. Set `alert_email` to a real mailbox you read (the example address is refused at plan time); keep `budget_monthly_usd = 25`, or 0 with the opt-out from step 38; leave the IC-WBT block commented out.
41. Initialise against the real state bucket: `AWS_PROFILE=pitman terraform -chdir=infra init -backend-config=backend.config` → "Terraform has been successfully initialized!".
42. Plan into a file: `AWS_PROFILE=pitman terraform -chdir=infra plan -out=tfplan` → `Plan: N to add, 0 to change, 0 to destroy`. A validation error names the variable to fix (an example `alert_email`, a 0 budget without the opt-out).
43. **Gate:** read the plan before applying it: nothing to change or destroy on a first apply; the Lambda, its role and grants, the user and usage tables, the spend breaker (topic, function, role), the WAF, CloudFront, SES and about two dozen alarms in two regions. The saved `infra/tfplan` holds the generated keys in plaintext; it is gitignored, and step 44 deletes it.
44. Apply exactly that plan, then delete it (about 15 minutes: the certificate and CloudFront): `AWS_PROFILE=pitman terraform -chdir=infra apply tfplan && rm infra/tfplan` → `Apply complete!`.
45. Confirm both "AWS Notification - Subscription Confirmation" emails (one per alert topic, af-south-1 and us-east-1): click the link in each.
46. **Gate:** fire a test alarm in each region and check both mails arrive (each alarm goes back to OK at its next evaluation, with no mail): `aws cloudwatch set-alarm-state --alarm-name pitman-lambda-errors --state-value ALARM --state-reason test --region af-south-1 --profile pitman`, then `aws cloudwatch set-alarm-state --alarm-name pitman-cloudfront-requests --state-value ALARM --state-reason test --region us-east-1 --profile pitman` → an "ALARM: …" mail for each within a few minutes. No mail: that region's subscription isn't confirmed (step 45). Never use a `pitman-breaker-api-*` alarm for this: setting one to ALARM trips the breaker for real and stops the API (`pnpm infra:breaker-reset pitman` undoes it).

### The first deploys

47. **Only once step 28 printed your login**, export the outputs to the repo variables (this switches the deploy workflows on): `AWS_PROFILE=pitman GH_REPO=Absence0760/pitman ~/github/templates/scripts/export-tf-vars.sh infra/` → ten `set var …` lines, no `set secret`.
48. Check they're there: `gh variable list --repo Absence0760/pitman` → the ten variables of § GitHub repo variables.
49. Deploy the API: `gh workflow run deploy-backend.yml --repo Absence0760/pitman --ref main`. The gate refuses unless CI passed on main's head (step 11, or CI's run on any commit since). Approve the waiting run in the Actions tab; it ends with `{"ok":true}` from the smoke check.
50. Deploy the site (`check-csp` refuses a build without SvelteKit's hash CSP, R4-I1): `gh workflow run deploy-frontend.yml --repo Absence0760/pitman --ref main`, then approve it.
51. Check the site answers with its CSP: `curl -sI https://pitman.jaredhoward.com/ | grep -i -e '^content-security-policy' -e '^strict-transport-security'` → both headers.
52. Check the API through CloudFront: `curl -s https://pitman.jaredhoward.com/api/health` → `{"ok":true}`. Then that a POST body gets through CloudFront's signature only with its hash (§ Lambda origin access control; signing out with no session is harmless): `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Origin: https://pitman.jaredhoward.com' -H 'content-type: application/json' -H 'x-amz-content-sha256: 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a' -d '{}' https://pitman.jaredhoward.com/api/auth/logout` → `204` (the hash is the SHA-256 of `{}`), and the same command without the `x-amz-content-sha256` header → `403`, Lambda's refusal of an unsigned payload.
53. Check the bare Function URL refuses a caller that skips CloudFront, at Lambda's front end and not in the app: `curl -s -w ' %{http_code}\n' "$(aws lambda get-function-url-config --function-name pitman-backend --region af-south-1 --profile pitman --query FunctionUrl --output text)health"` → `{"Message":"Forbidden"} 403` (Lambda's IAM refusal; the function never ran). `{"error":"forbidden"} 403` instead is the app's shared-secret check, so the call reached the function: the URL is not on `AWS_IAM`, re-apply `infra/`. Then check the resource policy names only CloudFront: `aws lambda get-policy --function-name pitman-backend --region af-south-1 --profile pitman --query Policy --output text | jq -c '.Statement[] | [.Sid, .Principal.Service, .Action]'` → exactly `["AllowCloudFrontServicePrincipal","cloudfront.amazonaws.com","lambda:InvokeFunctionUrl"]` and `["AllowCloudFrontServicePrincipalInvokeFunction","cloudfront.amazonaws.com","lambda:InvokeFunction"]` and nothing else (the SQS trigger needs no statement: an event source mapping polls with the function's role). Any `FunctionURLAllow…` statement: remove it (§ Lambda origin access control).

From here on, every push to `main` that CI passes and that touches a
surface's paths starts that deploy, waiting for your approval (§ How a
deploy happens). Until the steps below, the data routes answer 503 by
design (§ Lambda environment): quaternaries, delineation and channels (DEM),
Cape Farm Mapper land use, and CHIRPS and the MAP grid until IC-WBT's
grants. Sign-in mail reaches users once SES is out of the sandbox (step 57).

### Then: sign-in mail (SES, #28)

Start step 54 as soon as step 44 has applied: AWS reviews it by hand and it
can take a day or more. Until it's granted the account is in the SES sandbox,
where a send to an unverified recipient is refused (`MessageRejected`); the
users are unverified addresses, so sign-in mail works only after production
access. Each refusal is logged as `mail.send_failed` and raises the
`pitman-mail-send-failed` alarm; the mail worker tries each email 3 times,
then it lands in `pitman-mail-send-dlq` (its own alarm; don't redrive it, the
code has expired). After production access, sign in once for real and check
that both alarms stay OK.

54. Ask for SES production access in af-south-1 (transactional mail, low volume): `aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL --website-url https://pitman.jaredhoward.com --contact-language EN --use-case-description "Sign-in codes for an invite-only tool with a handful of users listed by an admin. No marketing mail. Bounces and complaints are suppressed by the configuration set and logged for the admin." --region af-south-1 --profile pitman`.
55. Check the domain identity has verified (the DKIM CNAMEs, MAIL FROM MX and SPF are in the zone from step 44; DNS can take up to an hour): `aws sesv2 get-email-identity --email-identity pitman.jaredhoward.com --region af-south-1 --profile pitman --query '{sending:VerifiedForSendingStatus,dkim:DkimAttributes.Status,mailFrom:MailFromAttributes.MailFromDomainStatus}'` → `true`, `SUCCESS`, `SUCCESS`.
56. Check DMARC is published: `dig +short TXT _dmarc.pitman.jaredhoward.com` → `"v=DMARC1; p=none; adkim=r; aspf=r"`.
57. Once AWS answers, check production access: `aws sesv2 get-account --region af-south-1 --profile pitman --query '{production:ProductionAccessEnabled,sending:SendingEnabled}'` → both `true`.
58. Confirm the af-south-1 alarms exist (Lambda errors, throttles, invocations, duration, SES bounce and complaint rates, the user table, `auth.locked`, `mail.send_failed`, `auth.unconfigured`, `auth.send_capped`, `auth.slow_code_request`, `cloudfront-secret-unset`, `mail-record-failed`, `mail-events-unrecorded`, `mail-events-dropped`, the mail-events DLQ, and for the sign-in mail queue `mail-enqueue-failed`, `mail-send-dropped`, `mail-send-dlq` and `mail-send-age`, the spend breaker's `breaker-api-concurrency`, `breaker-api-duration`, `breaker-api-invocations` and `breaker-errors`, and `usage-table-throttles`): `aws cloudwatch describe-alarms --alarm-name-prefix pitman- --region af-south-1 --profile pitman --query 'MetricAlarms[].AlarmName'`.
59. Confirm the us-east-1 alarms exist (`pitman-cloudfront-requests`, `pitman-cloudfront-bytes`, `pitman-route53-queries`, `pitman-cloudfront-5xx`, `pitman-waf-blocked`, `pitman-waf-auth-blocked`): `aws cloudwatch describe-alarms --alarm-name-prefix pitman- --region us-east-1 --profile pitman --query 'MetricAlarms[].AlarmName'`.

The first admin is added later with `pnpm admin:bootstrap` (A-AUTH-5,
§ Sign-in), never through Terraform.

### Then: IC-WBT's data (after Round 4.1)

60. Print the Lambda role ARN for the IC-WBT PR (4.1) to name as principal: `AWS_PROFILE=pitman terraform -chdir=infra output -raw lambda_role_arn`.
61. Once 4.1 is merged and applied in IC-WBT's account, uncomment and fill the IC-WBT block in `infra/terraform.tfvars` (`icwbt_account_id`, `chirps_bucket`, and `map_grid_bucket` + `map_grid_key` once D-4's decision is recorded): `$EDITOR infra/terraform.tfvars`.
62. Plan into a file: `AWS_PROFILE=pitman terraform -chdir=infra plan -out=tfplan` → the cross-account policy added and the Lambda's environment changed in place, nothing destroyed.
63. **Gate:** read the plan: only `lambda_cross_account_read` and the function's `CHIRPS_*` / `MAP_GRID_SOURCE` variables change.
64. Apply it and delete the plan: `AWS_PROFILE=pitman terraform -chdir=infra apply tfplan && rm infra/tfplan`.
65. Check a missing CHIRPS chunk reads as missing, not denied (R4-I2) with the backend's CHIRPS test call, and a real quaternary's monthly series comes back.

## What IC-WBT must grant (Round 4.1)

A separate PR in `project-water-management`'s `infra/` (its `/safe-edit`
flow): **bucket-policy statements** naming Pitman's Lambda role by exact
ARN (`aws:PrincipalArn` = step 60's output, never the whole Pitman account),
matching the identity policy `infra/lambda.tf` already carries. Rows from
`docs/data.md` § Cross-account access:

| Row | Bucket | Grant to Pitman's Lambda role | Pitman side |
|---|---|---|---|
| 1 | `water-management-mirror-<id>` | `s3:GetObject` on `rnl/*` only: not the root `zarr.json`, which the reader never opens (`store.test.ts`; `chirps_root_metadata` defaults to off, R4-I11) | `ChirpsRead` |
| 2 | same | `s3:ListBucket` on the bucket, `StringLike s3:prefix ["rnl/*"]` | `ChirpsListPrefix` |
| 5 | `water-management-reference-<id>` | `s3:GetObject` on the one MAP-grid key | `MapGridRead` |

IC-WBT's `DenyInsecureTransport` statements stay. All three buckets are
SSE-S3, so there is no KMS grant. Rows 3, 4 and 6 (the DEM, the water
occurrence tiles, and the browser's `/tiles/*` through Pitman's CloudFront)
are Rounds 5 and 7; Pitman's side adds them then. Not granted, ever: any other
mirror prefix, any other reference object, any write, delete or list outside
`rnl/`, any database access.

## Secrets

Pitman's runtime secrets are three values Terraform generates and keeps in
its (encrypted, in-account) state and passes to the Lambda's environment;
nobody handles them:

- the CloudFront shared secret: rotate with `AWS_PROFILE=pitman terraform -chdir=infra apply -replace=random_password.cloudfront_shared_secret` (a few seconds of 403s while CloudFront propagates);
- `AUTH_SESSION_KEY`: rotate with `AWS_PROFILE=pitman terraform -chdir=infra apply -replace=random_password.auth_session_key`, which signs everyone out (A-AUTH-8);
- `AUTH_CODE_KEY`: rotate with `AWS_PROFILE=pitman terraform -chdir=infra apply -replace=random_password.auth_code_key`, which voids codes in flight and resets the per-address send counters.

Removing an address from SES's suppression list is the operator's; the Lambda has no permission to do it (A-AUTH-7). For an erasure, `pnpm admin:erase` does it with the address it read from stdin (`docs/security.md` § Erasure; the `pitman` profile needs `ses:DeleteSuppressedDestination`). Outside an erasure (an address that bounced and is now fixed), keep the address out of shell history by reading it into a variable: `read -r A && aws sesv2 delete-suppressed-destination --email-address "$A" --region af-south-1 --profile pitman`.

CI's one secret is `AUTH_KIT_READ_TOKEN` (§ Sign-in), a read-only token for the private auth-kit repo, held as an Actions and a Dependabot secret (auth-kit#2).

Secrets that come later (the Cape Farm Mapper token, D3) live SOPS-encrypted
in the private `infra-secrets/pitman/` under `alias/pitman-sops`, never in
this repo; the operator creates and edits them (`sops infra-secrets/pitman/prod.sops.yaml`), and
Claude only checks that they exist. The token reaches the Lambda through the `cfm_token` variable (§ Lambda environment). See `../infra-secrets/README.md`.

## Sign-in

Sign-in's rules come from the private package `@absence0760/auth-kit`,
installed from git at a pinned tag (`backend/package.json`). Its operator
setup is Absence0760/auth-kit#2; the pitman side:

- **CI access.** Every workflow that runs `pnpm install` (`ci.yml`,
  `audit.yml`, `coverage.yml`, `deploy-backend.yml`, `deploy-frontend.yml`, `fresh-clone.yml`,
  `dependabot-lockfile.yml`) fetches auth-kit with the
  **`AUTH_KIT_READ_TOKEN`** secret: a fine-grained token limited to
  `Absence0760/auth-kit` with Contents read-only (write its expiry down). It
  must be stored twice, as an **Actions** secret and as a **Dependabot**
  secret, both named `AUTH_KIT_READ_TOKEN`. Without it those jobs fail at once
  with the setup link (a check step that only tests the secret is set). The
  token reaches git on the install step alone, as environment-only config
  (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`, an
  `insteadOf` for auth-kit's three URL forms); nothing writes it to
  `~/.gitconfig`, so the tests, Playwright, the builds and the deploy steps
  that run later in the same job, beside the AWS session, can't read it.
  `scripts/ci-guards/workflows.test.mjs` (`pnpm test:tools`) fails if a
  workflow puts it anywhere else.
- **No pnpm store cache.** `actions/setup-node` with `cache: pnpm` would
  save the pnpm store, auth-kit's built package included, keyed on the
  lockfile. A `pull_request` run may restore caches saved on `main`, and a
  fork's pull request runs the fork's own copy of the workflow, so no
  condition in these files could stop a fork of the public repo restoring
  that cache. So no workflow that installs auth-kit caches the store (no
  `cache:` input, no `actions/cache`); `scripts/ci-guards/workflows.test.mjs`
  fails if one does. Installs are a little slower for it. Caches saved before
  the change must be deleted (`gh cache delete --all`) before the repo goes
  public (§ First deploy). `dependabot.yml` reads it through its `github-auth-kit`
  registry, and `dependabot-lockfile.yml`'s regenerate job gets it (read-only,
  with `--ignore-scripts`) so it can resolve the lockfile. `claude.yml` doesn't
  get it, so Claude's own `pnpm install` there can't fetch auth-kit.
- **Bumping auth-kit.** Dependabot proposes new tags without the 7-day
  cooldown. pnpm 10 builds a git dependency only when its exact resolution is
  in `pnpm-workspace.yaml`'s `onlyBuiltDependencies` (and `allowBuilds` for
  pnpm 11), commit SHA included, so a bump also replaces that line with the
  one the failing install prints: a moved tag can't run new build code
  without a reviewed change. An auth-kit bump comes as its own Dependabot PR
  and is never auto-merged: `dependabot-auto-merge.yml` skips it, and
  `scripts/ci-guards/workflows.test.mjs` guards that.
- **The first admin**, once, after the first deploy with sign-in configured
  (P2 applied): run `pnpm admin:bootstrap` and type your address when it asks.
  It uses the `pitman` profile (`AWS_PROFILE`), reads the table and code key
  from the `pitman-backend` Lambda's environment (`LAMBDA_FUNCTION`, `AWS_REGION`
  override), and refuses if an admin already exists. Then sign in and add a
  second admin at once (one locked-out mailbox shouldn't lock out admin).
- **Locked out**: `pnpm admin:clear-lock` clears an address's lock without
  changing its role; `pnpm admin:recover` makes a listed address an admin
  again (break-glass). **Erasure**: `pnpm admin:erase`, part of
  `docs/security.md` § Erasure. **Access request** (POPIA s23):
  `pnpm admin:export`, part of `docs/security.md` § Access requests; it asks
  for an absolute path outside the repository and writes the JSON there.
  Each script reads the address from stdin and is audited as `operator`; the
  operator's credentials need the `DYNAMODB_IAM_ACTIONS` on the table and
  `lambda:GetFunctionConfiguration` on the function, plus
  `ses:DeleteSuppressedDestination` for `admin:erase` and
  `ses:GetSuppressedDestination` for `admin:export`.

## Changing the infrastructure

`AWS_PROFILE=pitman terraform -chdir=infra plan -out=tfplan`, read it, then `AWS_PROFILE=pitman terraform -chdir=infra apply tfplan && rm infra/tfplan` (the saved plan holds the generated keys in plaintext; `tfplan` is gitignored); re-run step 47 if an output changed. Claude never runs `apply` (nor a plan against the real backend). CI checks every `infra/` change credential-free (`terraform.yml`: fmt, validate, Trivy); `terraform -chdir=infra test` runs the mocked-provider tests in `infra/tests/`, and `node --test infra/scripts/*.test.mjs` the CSP guard's, the CloudFront functions' and the spend breaker's tests.

## Rollback

Revert the bad commit on `main` and push; the matching workflow redeploys the
previous code (approve it). Terraform changes roll back the same way, through
a plan and apply of the reverted `infra/`.

## Claude Code automation

The `claude.yml` workflow responds to `@claude` mentions. The authorized
user is configured via the `CLAUDE_AUTHORIZED_USER` repository variable
(Settings > Variables > Actions).
