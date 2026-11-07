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
              └─ /api/*  ─► strip /api ─► Lambda Function URL (+ shared-secret header)
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
*secret* nobody reads; so the bare Function URL is not an output (step 49
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
| `CLOUDFRONT_SHARED_SECRET` | generated by Terraform | the app rejects any request without CloudFront's `X-CloudFront-Shared-Secret` header (in Terraform state only); unset or empty on Lambda, every request is 503 |
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

**Not set yet, so those routes answer 503 by design** (not a failed deploy):
`QUATERNARIES_SOURCE` (the quaternary catalogue, `/quaternaries`, until
Pitman's own bucket exists, D-1), `DEM_SOURCE` (delineation and channels,
until Round 5's DEM grant), `CFM_SOURCE` / `CFM_TOKEN` (Cape Farm Mapper land
use, `/cfm`, until the token is wired, D3), and, until IC-WBT's grants
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

## First deploy (operator runbook)

Claude prepares and checks; the operator runs every command below (they
need the operator's AWS and GitHub credentials). One step at a time, in
order: each says what to expect, and a step marked **Gate** must show that
before you go on. Run the repo commands from the root of a pitman checkout on
`main`. `pitman` is the SSO profile made in step 17.

The order is deliberate. CI must be green before anything deploys; the AWS
account is bootstrapped while the repo is still private (on a public repo
the bootstrap's last stage would make `main` PR-only); the repo goes public
only after the pnpm caches holding auth-kit are gone and the history is
clean; and the `production` environment, with you as required reviewer,
exists before the step that switches the deploy workflows on (on GitHub
Free a required reviewer needs a public repo, and a workflow that names a
missing environment creates it with no reviewer).

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

6. Create the auth-kit read token as Absence0760/auth-kit#2 describes (github.com → Settings → Developer settings → Fine-grained tokens: resource owner Absence0760, only `Absence0760/auth-kit`, Contents read-only). Write its expiry date down.
7. Store it as an Actions secret (paste at the hidden prompt): `gh secret set AUTH_KIT_READ_TOKEN --app actions --repo Absence0760/pitman`.
8. Store it as a Dependabot secret too: `gh secret set AUTH_KIT_READ_TOKEN --app dependabot --repo Absence0760/pitman`.
9. Check both exist (names only): `gh secret list --app actions --repo Absence0760/pitman && gh secret list --app dependabot --repo Absence0760/pitman` → `AUTH_KIT_READ_TOKEN` in each.
10. Re-run CI on main: `gh workflow run ci.yml --repo Absence0760/pitman --ref main`.
11. **Gate:** after about ten minutes, `gh run list --workflow ci.yml --branch main --limit 1 --repo Absence0760/pitman --json headSha,status,conclusion` → `completed`, `success`. Red: fix it before anything else; no deploy can run on a red commit.

### The AWS account (while the repo is still private)

12. Read the bootstrap's project file (committed and pushed in infra-secrets; settings, not secrets): `cat ~/github/infra-secrets/pitman/bootstrap.tfvars` → `project = "pitman"`, `account_name = "Pitman"`, `region = "us-east-1"` (the tfstate bucket and `alias/pitman-sops`; `af-south-1` isn't enabled in a new account yet, R4-I3), `create_subdomain = true`, `parent_domain = "jaredhoward.com"`, `github_repo = "Absence0760/pitman"`, `github_environment = "production"`, and `github_subject_prefix = "repo:Absence0760@21693150/pitman@1437736870"`.
13. **Gate:** the subject prefix matches what GitHub puts in this repo's OIDC tokens: `gh api repos/Absence0760/pitman/actions/oidc/customization/sub --jq .sub_claim_prefix` → `repo:Absence0760@21693150/pitman@1437736870`, exactly as in step 12. This repo uses immutable subject claims (owner and repo each with its numeric ID); a plain `repo:Absence0760/pitman` would never match, and the first deploy would fail `AssumeRoleWithWebIdentity` without naming either subject (project-mgmt Runbook G).
14. Dry-run the bootstrap: `cd ~/github/templates && ./scripts/new-project-account.sh pitman --plan`. Expect stage 1's plan only: one `aws_organizations_account` named `Pitman` to add, nothing to change or destroy. Read it: creating an account can't be undone.
15. Run it: `cd ~/github/templates && ./scripts/new-project-account.sh pitman`. Stages 1 to 3 create the account, the baseline (tfstate bucket, `alias/pitman-sops`, the GitHub OIDC provider and the `pitman-deploy` role, the `pitman.jaredhoward.com` zone) and the delegation in `jaredhoward.com`. Note the **account id** and the **tfstate bucket** from its summary. Stage 4 prints two warnings while the repo is private (the environment PUT and branch protection both need a public repo on GitHub Free): expected, step 27 creates the environment. If stage 2 fails with `NotSignedUp`, `SubscriptionRequiredException` or `OptInRequired`, the new account's services are still activating: wait a few minutes and run the same command again. **Never run this script again once the repo is public:** its stage 4 would make `main` PR-only, enforced on admins.
16. Give yourself access (Runbook D, console): in `personal-mgmt`, IAM Identity Center → AWS accounts → `Pitman` → Assign users or groups → user `Jared` → permission set `AdministratorAccess`.
17. Add the profile: `aws configure sso --profile pitman`. Reuse the session `personal`; pick the `Pitman` account and `AdministratorAccess`; default region `af-south-1`.
18. **Gate:** `aws sts get-caller-identity --profile pitman --query Account --output text` → the account id from step 15.
19. Check the child zone is delegated: `dig +short NS pitman.jaredhoward.com` → four `awsdns` servers (minutes after step 15).

### Going public, then the `production` environment

20. **Gate:** no workflow on `main` caches the pnpm store any more (it would hold auth-kit's code): `git fetch origin && git grep -nE '^[[:space:]]*cache:' origin/main -- .github/workflows/` → no output.
21. Delete the caches saved before that change: `gh cache delete --all --repo Absence0760/pitman`.
22. **Gate:** `gh cache list --repo Absence0760/pitman` → nothing listed.
23. **Gate:** no client term anywhere in the history (needs `~/github/infra-secrets/pitman/client-terms.txt`; `docs/security.md` § Public repo hygiene): `pnpm check:terms --history` → `Client terms OK (the history of every ref).` A "No client terms file" line means it checked nothing: fix the file first.
24. Run the full-history secret scan: `gh workflow run gitleaks-sweep.yml --repo Absence0760/pitman --ref main`.
25. **Gate:** `gh run list --workflow gitleaks-sweep.yml --limit 1 --repo Absence0760/pitman --json status,conclusion` → `completed`, `success`. A finding: rotate the secret and clean the history before going on.
26. Make the repo public: `gh repo edit Absence0760/pitman --visibility public --accept-visibility-change-consequences`.
27. Create the environment with you as required reviewer: `~/github/templates/scripts/backfill-prod-environment.sh --apply Absence0760/pitman` → `FIXED (MISSING -> required reviewer = <your login>)`.
28. **Gate:** `gh api repos/Absence0760/pitman/environments/production --jq '.protection_rules[] | select(.type=="required_reviewers") | .reviewers[].reviewer.login'` → your login. Don't reach step 43 without it.

### Region, quota and billing

29. Enable `af-south-1` in the account: `aws account enable-region --region-name af-south-1 --region us-east-1 --profile pitman`.
30. **Gate:** wait until it reports `ENABLED` (minutes, sometimes hours): `aws account get-region-opt-status --region-name af-south-1 --region us-east-1 --profile pitman --query RegionOptStatus --output text`.
31. Check the Lambda concurrency quota (must be at least `lambda_reserved_concurrency` + 10 = 20): `aws service-quotas get-service-quota --service-code lambda --quota-code L-B99A9384 --region af-south-1 --profile pitman --query Quota.Value`. A `NoSuchResourceException` means the quota has never been touched: read the default instead with `aws service-quotas get-aws-default-service-quota --service-code lambda --quota-code L-B99A9384 --region af-south-1 --profile pitman --query Quota.Value`.
32. If it's below 20, ask for 1 000 (usually granted automatically, can take a day): `aws service-quotas request-service-quota-increase --service-code lambda --quota-code L-B99A9384 --desired-value 1000 --region af-south-1 --profile pitman`.
33. Check whether the org manages root centrally: `aws iam list-organizations-features --profile mgmt --query EnabledFeatures`. The budget (`infra/alarms.tf`) can't be created until **IAM access to billing information** is on in the account, a root-only toggle, and an account the org created has no root password.
34. Turn billing access on, or take the explicit opt-out:
    - **If step 33 lists neither `RootCredentialsManagement` nor `RootSessions`:** open the root sign-in page (signin.aws.amazon.com, "Root user"), enter the `account_email` from step 12, choose "Forgot password", set a strong password from the reset mail (keep it in Bitwarden), sign in, add MFA, then Account → "IAM user and role access to Billing information" → Edit → Activate. Sign out of root.
    - **If root is managed centrally, or you'd rather not touch root yet:** in step 36 set `budget_monthly_usd = 0` **and** `no_budget_acknowledged = true` (Terraform refuses 0 without it). The CloudWatch alarms still run. Come back later: enable billing access, set the budget, remove the opt-out, plan and apply.

### Terraform

35. Write the backend config, with the tfstate bucket from step 15 and region `us-east-1`: `cp infra/backend.config.example infra/backend.config && $EDITOR infra/backend.config`.
36. Write the variables: `cp infra/terraform.tfvars.example infra/terraform.tfvars && $EDITOR infra/terraform.tfvars`. Set `alert_email` to a real mailbox you read (the example address is refused at plan time); keep `budget_monthly_usd = 25`, or 0 with the opt-out from step 34; leave the IC-WBT block commented out.
37. Initialise against the real state bucket: `AWS_PROFILE=pitman terraform -chdir=infra init -backend-config=backend.config` → "Terraform has been successfully initialized!".
38. Plan into a file: `AWS_PROFILE=pitman terraform -chdir=infra plan -out=tfplan` → `Plan: N to add, 0 to change, 0 to destroy`. A validation error names the variable to fix (an example `alert_email`, a 0 budget without the opt-out).
39. **Gate:** read the plan before applying it: nothing to change or destroy on a first apply; the Lambda, its role and grants, the user table, the WAF, CloudFront, SES and about two dozen alarms in two regions. The saved `infra/tfplan` holds the generated keys in plaintext; it is gitignored, and step 40 deletes it.
40. Apply exactly that plan, then delete it (about 15 minutes: the certificate and CloudFront): `AWS_PROFILE=pitman terraform -chdir=infra apply tfplan && rm infra/tfplan` → `Apply complete!`.
41. Confirm both "AWS Notification - Subscription Confirmation" emails (one per alert topic, af-south-1 and us-east-1): click the link in each.
42. **Gate:** fire a test alarm in each region and check both mails arrive (each alarm goes back to OK at its next evaluation, with no mail): `aws cloudwatch set-alarm-state --alarm-name pitman-lambda-errors --state-value ALARM --state-reason test --region af-south-1 --profile pitman`, then `aws cloudwatch set-alarm-state --alarm-name pitman-cloudfront-requests --state-value ALARM --state-reason test --region us-east-1 --profile pitman` → an "ALARM: …" mail for each within a few minutes. No mail: that region's subscription isn't confirmed (step 41).

### The first deploys

43. **Only once step 28 printed your login**, export the outputs to the repo variables (this switches the deploy workflows on): `AWS_PROFILE=pitman GH_REPO=Absence0760/pitman ~/github/templates/scripts/export-tf-vars.sh infra/` → ten `set var …` lines, no `set secret`.
44. Check they're there: `gh variable list --repo Absence0760/pitman` → the ten variables of § GitHub repo variables.
45. Deploy the API: `gh workflow run deploy-backend.yml --repo Absence0760/pitman --ref main`. The gate refuses unless CI passed on main's head (step 11, or CI's run on any commit since). Approve the waiting run in the Actions tab; it ends with `{"ok":true}` from the smoke check.
46. Deploy the site (`check-csp` refuses a build without SvelteKit's hash CSP, R4-I1): `gh workflow run deploy-frontend.yml --repo Absence0760/pitman --ref main`, then approve it.
47. Check the site answers with its CSP: `curl -sI https://pitman.jaredhoward.com/ | grep -i -e '^content-security-policy' -e '^strict-transport-security'` → both headers.
48. Check the API through CloudFront: `curl -s https://pitman.jaredhoward.com/api/health` → `{"ok":true}`.
49. Check the bare Function URL refuses a caller that skips CloudFront: `curl -s "$(aws lambda get-function-url-config --function-name pitman-backend --region af-south-1 --profile pitman --query FunctionUrl --output text)health"` → `{"error":"forbidden"}`.

From here on, every push to `main` that CI passes and that touches a
surface's paths starts that deploy, waiting for your approval (§ How a
deploy happens). Until the steps below, the data routes answer 503 by
design (§ Lambda environment): quaternaries, delineation and channels (DEM),
Cape Farm Mapper land use, and CHIRPS and the MAP grid until IC-WBT's
grants. Sign-in mail reaches users once SES is out of the sandbox (step 53).

### Then: sign-in mail (SES, #28)

Start step 50 as soon as step 40 has applied: AWS reviews it by hand and it
can take a day or more. Until it's granted the account is in the SES sandbox,
where a send to an unverified recipient is refused (`MessageRejected`); the
users are unverified addresses, so sign-in mail works only after production
access. Each refusal is logged as `mail.send_failed` and raises the
`pitman-mail-send-failed` alarm; the mail worker tries each email 3 times,
then it lands in `pitman-mail-send-dlq` (its own alarm; don't redrive it, the
code has expired). After production access, sign in once for real and check
that both alarms stay OK.

50. Ask for SES production access in af-south-1 (transactional mail, low volume): `aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL --website-url https://pitman.jaredhoward.com --contact-language EN --use-case-description "Sign-in codes for an invite-only tool with a handful of users listed by an admin. No marketing mail. Bounces and complaints are suppressed by the configuration set and logged for the admin." --region af-south-1 --profile pitman`.
51. Check the domain identity has verified (the DKIM CNAMEs, MAIL FROM MX and SPF are in the zone from step 40; DNS can take up to an hour): `aws sesv2 get-email-identity --email-identity pitman.jaredhoward.com --region af-south-1 --profile pitman --query '{sending:VerifiedForSendingStatus,dkim:DkimAttributes.Status,mailFrom:MailFromAttributes.MailFromDomainStatus}'` → `true`, `SUCCESS`, `SUCCESS`.
52. Check DMARC is published: `dig +short TXT _dmarc.pitman.jaredhoward.com` → `"v=DMARC1; p=none; adkim=r; aspf=r"`.
53. Once AWS answers, check production access: `aws sesv2 get-account --region af-south-1 --profile pitman --query '{production:ProductionAccessEnabled,sending:SendingEnabled}'` → both `true`.
54. Confirm the af-south-1 alarms exist (Lambda errors, throttles, invocations, duration, SES bounce and complaint rates, the user table, `auth.locked`, `mail.send_failed`, `auth.unconfigured`, `auth.send_capped`, `auth.slow_code_request`, `cloudfront-secret-unset`, `mail-record-failed`, `mail-events-unrecorded`, `mail-events-dropped`, the mail-events DLQ, and for the sign-in mail queue `mail-enqueue-failed`, `mail-send-dropped`, `mail-send-dlq` and `mail-send-age`): `aws cloudwatch describe-alarms --alarm-name-prefix pitman- --region af-south-1 --profile pitman --query 'MetricAlarms[].AlarmName'`.
55. Confirm the us-east-1 alarms exist (`pitman-cloudfront-requests`, `pitman-cloudfront-bytes`, `pitman-cloudfront-5xx`, `pitman-waf-blocked`, `pitman-waf-auth-blocked`): `aws cloudwatch describe-alarms --alarm-name-prefix pitman- --region us-east-1 --profile pitman --query 'MetricAlarms[].AlarmName'`.

The first admin is added later with `pnpm admin:bootstrap` (A-AUTH-5,
§ Sign-in), never through Terraform.

### Then: IC-WBT's data (after Round 4.1)

56. Print the Lambda role ARN for the IC-WBT PR (4.1) to name as principal: `AWS_PROFILE=pitman terraform -chdir=infra output -raw lambda_role_arn`.
57. Once 4.1 is merged and applied in IC-WBT's account, uncomment and fill the IC-WBT block in `infra/terraform.tfvars` (`icwbt_account_id`, `chirps_bucket`, and `map_grid_bucket` + `map_grid_key` once D-4's decision is recorded): `$EDITOR infra/terraform.tfvars`.
58. Plan into a file: `AWS_PROFILE=pitman terraform -chdir=infra plan -out=tfplan` → the cross-account policy added and the Lambda's environment changed in place, nothing destroyed.
59. **Gate:** read the plan: only `lambda_cross_account_read` and the function's `CHIRPS_*` / `MAP_GRID_SOURCE` variables change.
60. Apply it and delete the plan: `AWS_PROFILE=pitman terraform -chdir=infra apply tfplan && rm infra/tfplan`.
61. Check a missing CHIRPS chunk reads as missing, not denied (R4-I2) with the backend's CHIRPS test call, and a real quaternary's monthly series comes back.

## What IC-WBT must grant (Round 4.1)

A separate PR in `project-water-management`'s `infra/` (its `/safe-edit`
flow): **bucket-policy statements** naming Pitman's Lambda role by exact
ARN (`aws:PrincipalArn` = step 56's output, never the whole Pitman account),
matching the identity policy `infra/lambda.tf` already carries. Rows from
`docs/data.md` § Cross-account access:

| Row | Bucket | Grant to Pitman's Lambda role | Pitman side |
|---|---|---|---|
| 1 | `water-management-mirror-<id>` | `s3:GetObject` on `rnl/*` (and `zarr.json` at the root, if 4.2's test shows the reader opens it) | `ChirpsRead` |
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
Claude only checks that they exist. See `../infra-secrets/README.md`.

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
  without a reviewed change.
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

`AWS_PROFILE=pitman terraform -chdir=infra plan -out=tfplan`, read it, then `AWS_PROFILE=pitman terraform -chdir=infra apply tfplan && rm infra/tfplan` (the saved plan holds the generated keys in plaintext; `tfplan` is gitignored); re-run step 43 if an output changed. Claude never runs `apply` (nor a plan against the real backend). CI checks every `infra/` change credential-free (`terraform.yml`: fmt, validate, Trivy); `terraform -chdir=infra test` runs the mocked-provider tests in `infra/tests/`, and `node --test infra/scripts/*.test.mjs` the CSP guard's and the CloudFront functions' tests.

## Rollback

Revert the bad commit on `main` and push; the matching workflow redeploys the
previous code (approve it). Terraform changes roll back the same way, through
a plan and apply of the reverted `infra/`.

## Claude Code automation

The `claude.yml` workflow responds to `@claude` mentions. The authorized
user is configured via the `CLAUDE_AUTHORIZED_USER` repository variable
(Settings > Variables > Actions).
