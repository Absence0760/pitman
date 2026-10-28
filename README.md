# pitman

Full-stack web template: static SvelteKit frontend + Hono serverless backend, deployed to AWS via Terraform and GitHub Actions with OIDC federation.

## Stack

- **Frontend**: SvelteKit (Svelte 5) with `adapter-static`, hosted on S3 + CloudFront
- **Backend**: Hono on AWS Lambda (via Function URL)
- **Infrastructure**: Terraform (`infra/`) — S3, CloudFront, Lambda, IAM, Route 53, ACM, GitHub OIDC
- **CI/CD**: GitHub Actions with OIDC federation (no long-lived AWS keys)
- **Secrets**: SOPS + AWS KMS, stored in the private `infra-secrets` repo (one subdir per project) — never committed to this repo

## Repo layout

```
pitman/
├── frontend/       SvelteKit site (vitest)
├── backend/        Hono API (local Node server + AWS Lambda entry)
├── infra/          Terraform — all AWS resources
├── scripts/        dev / build / check tooling
├── .github/
│   └── workflows/  CI + deploy pipelines + Claude Code automation
└── docs/           Architecture, deployment, run-locally, security
```

## Quick start

```bash
pnpm install
pnpm dev                    # frontend (:7777) + backend (:3001)
```

Local dev needs no env setup — both workspaces ship a committed `.env.development`
with non-sensitive local defaults. Production secrets live in the private
`infra-secrets` repo (not here) and are only needed for deploying; see
[Production deploy](#production-deploy) below.

See [`docs/run-locally.md`](./docs/run-locally.md) for the full setup walkthrough.

## Production deploy

```bash
# Provision the AWS sub-account (one-time, run from ~/repos/templates):
./scripts/new-project-account.sh <slug>

# In this repo, then:
cp infra/backend.config.example infra/backend.config && $EDITOR infra/backend.config
cp infra/terraform.tfvars.example infra/terraform.tfvars && $EDITOR infra/terraform.tfvars
cd infra && terraform init -backend-config=backend.config && terraform apply
~/repos/templates/scripts/export-tf-vars.sh infra/   # push outputs to gh vars + secrets
```

See [`docs/deployment.md`](./docs/deployment.md) and [`infra/README.md`](./infra/README.md) for the full walkthrough.

## Documentation

- [`docs/architecture.md`](./docs/architecture.md) — how the pieces fit together
- [`docs/run-locally.md`](./docs/run-locally.md) — local dev setup
- [`docs/deployment.md`](./docs/deployment.md) — AWS deploy walkthrough
- [`docs/security.md`](./docs/security.md) — risk register, mitigations
- [`infra/README.md`](./infra/README.md) — Terraform module specifics

## Commands

```bash
pnpm dev                    # frontend + backend in parallel
pnpm build                  # build all packages
pnpm check                  # typecheck all packages
pnpm test                   # test all packages

pnpm frontend <script>      # shortcut: pnpm --filter @pitman/frontend
pnpm backend <script>       # shortcut: pnpm --filter @pitman/backend
```

## Customizing this template

1. Find-and-replace `pitman` with your project name across all files
2. Bootstrap the project's secrets slot in the private `infra-secrets` repo:
   `cd ../infra-secrets && ./bin/sops-init.sh --project <your-slug> --region <region>`
   (secrets live there, not in this repo — see `docs/deployment.md`)
3. Set `bootstrap_slug` in `infra/terraform.tfvars` to match the slug
   `new-project-account.sh` was run with
4. Fill in `infra/terraform.tfvars` with your values (apex domain,
   route53 zone ID, optional budget email)
5. Add your API routes in `backend/src/routes/`
6. Build your frontend in `frontend/src/routes/`
