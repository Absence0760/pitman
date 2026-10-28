# Deployment

## Overview

The project deploys to AWS via GitHub Actions with OIDC federation (no
long-lived AWS keys). Two independent deploy workflows fire when a GitHub
release is published, each with a skip-if-unchanged check.

## Prerequisites

- AWS account with the target region enabled
- Domain registered + Route 53 hosted zone existing
- Terraform >= 1.6
- GitHub CLI (`gh`) authenticated
- `sops` + `jq` installed

## Secrets management

Production secrets do **not** live in this repo. They live in the private estate
repo `infra-secrets` (sibling of this repo under `~/github/`), in
`infra-secrets/<project-slug>/`, SOPS-encrypted under this project's own KMS key
`alias/<project-slug>-sops`. Decryption requires `kms:Decrypt` on that key via AWS
IAM (access is IAM, not repo membership). See `../infra-secrets/README.md` for the
full model.

- `infra-secrets/<project-slug>/prod.sops.yaml` — encrypted production secrets,
  consumed by this project's Terraform via the `carlpett/sops` provider
  (`data "sops_file"`).

### First-time setup

Authenticated to the project's AWS account, bootstrap the slot once:

```bash
cd ../infra-secrets
./bin/sops-init.sh --project <project-slug> --region <region>   # creates alias/<project-slug>-sops, wires the ARN into .sops.yaml
sops <project-slug>/prod.sops.yaml    # seed from the .example, fill real values, save ENCRYPTED
```

### Daily workflow

- Edit a secret: `sops ../infra-secrets/<project-slug>/prod.sops.yaml`
- Add a collaborator: grant them `kms:Decrypt` on `alias/<project-slug>-sops` (IAM)
- Local dev usually needs no secrets (committed `backend/.env.development` covers it). If you need a real value locally, read it out of the encrypted file (`sops -d ../infra-secrets/<project-slug>/prod.sops.yaml`) and put it in a gitignored `backend/.env.development.local`

## One-command bootstrap

```bash
./bin/setup.sh
```

This handles:
1. Terraform state bucket + DynamoDB lock table creation
2. `terraform init` + `terraform apply`
3. GitHub Actions environment variables population

## Release-gated deploys

Deploys fire on GitHub releases, not on every push. Each workflow has a
skip-if-unchanged check job that compares against the previous release tag.

To deploy:

```bash
gh release create v0.1.0 --generate-notes --target main
```

This fires both deploy workflows. Each checks whether its workspace
files changed and skips if not.

## Manual deploys

Each workflow also supports `workflow_dispatch` for manual re-runs:

```bash
gh workflow run deploy-frontend.yml
gh workflow run deploy-backend.yml
```

## GitHub Actions environment variables

Set by `bin/setup.sh` in the `production` environment:

| Variable | Source |
|---|---|
| `AWS_REGION` | `terraform.tfvars` |
| `AWS_ROLE_TO_ASSUME` | `terraform output github_actions_role_arn` |
| `FRONTEND_BUCKET` | `terraform output frontend_bucket_name` |
| `CLOUDFRONT_DISTRIBUTION_ID` | `terraform output cloudfront_distribution_id` |
| `LAMBDA_FUNCTION_NAME` | `terraform output lambda_function_name` |
| `PUBLIC_API_URL` | `terraform output lambda_function_url` |
| `PUBLIC_SITE_URL` | `https://<domain>` |

## GitHub Actions secrets

| Secret | Purpose |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code automation |

## Claude Code automation

The `claude.yml` workflow responds to `@claude` mentions. The authorized
user is configured via the `CLAUDE_AUTHORIZED_USER` repository variable
(Settings > Variables > Actions).

## Rollback

Re-run the previous deploy workflow from the GitHub Actions UI, or trigger
a manual deploy of the last known-good release tag.
