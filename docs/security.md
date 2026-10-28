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

- **GitHub OIDC trust policy** is scoped to the `main` branch only.
- **S3 bucket** has public access blocked; only CloudFront (via OAC) can read.
- **Lambda Function URL** CORS is scoped to the site domain.

## Incident playbook

1. **Suspected secret leak** — rotate at the source dashboard, update
   `../infra-secrets/<project-slug>/prod.sops.yaml` (`sops`), run `terraform apply`.
2. **IAM credential leaked** — deactivate immediately, check CloudTrail,
   rotate all secrets if `kms:Decrypt` was available.
3. **AWS account compromised** — full account recovery, rotate everything,
   re-provision infrastructure.

## Known gaps

- No rate limiting on API endpoints (add when needed).
- No automated dependency scanning (consider `pnpm audit` in CI).
