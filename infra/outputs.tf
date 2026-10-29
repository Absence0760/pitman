# Every output except lambda_function_url is pushed to a GitHub repo variable
# by `~/github/templates/scripts/export-tf-vars.sh infra/` (non-sensitive ->
# `gh variable set <NAME uppercased>`); the deploy workflows read them as
# vars.<NAME> and skip cleanly while they are unset.

output "aws_region" {
  description = "Primary region (the Lambda and the site bucket). Repo variable AWS_REGION."
  value       = var.aws_region
}

output "frontend_bucket" {
  description = "Site bucket. Repo variable FRONTEND_BUCKET (deploy-frontend syncs to it)."
  value       = aws_s3_bucket.frontend.bucket
}

output "cloudfront_distribution_id" {
  description = "Distribution ID. Repo variable CLOUDFRONT_DISTRIBUTION_ID (deploy-frontend invalidates it)."
  value       = aws_cloudfront_distribution.frontend.id
}

output "cloudfront_domain_name" {
  description = "The *.cloudfront.net name, for checking before DNS has propagated."
  value       = aws_cloudfront_distribution.frontend.domain_name
}

output "lambda_function_name" {
  description = "API Lambda name. Repo variable LAMBDA_FUNCTION_NAME (deploy-backend updates its code)."
  value       = aws_lambda_function.backend.function_name
}

output "public_api_url" {
  description = "Same-origin API base the frontend is built with. Repo variable PUBLIC_API_URL."
  value       = "https://${var.domain_name}/api"
}

output "public_site_url" {
  description = "The site's URL. Repo variable PUBLIC_SITE_URL."
  value       = "https://${var.domain_name}"
}

# Not sensitive on purpose, so export-tf-vars.sh makes it a repo *variable*:
# a role ARN only names the role (AWS does not treat account IDs as secret),
# assuming it needs a GitHub OIDC token for this repo's `production`
# environment, which needs the required reviewer's approval. As a variable,
# the deploy workflows can test it in a job-level `if` and stay inert until
# it is set (secrets can't be read there).
output "aws_deploy_role_arn" {
  description = "The bootstrap's deploy role that GitHub Actions assumes via OIDC. Repo variable AWS_DEPLOY_ROLE_ARN."
  value       = data.aws_iam_role.github_deploy.arn
}

# IC-WBT's bucket policies (Round 4.1) name this exact ARN as the principal
# (aws:PrincipalArn). Hand it to that PR; not needed by CI.
output "lambda_role_arn" {
  description = "API Lambda execution role: the principal IC-WBT's mirror and reference bucket policies grant (docs/data.md § Cross-account access)."
  value       = aws_iam_role.lambda.arn
}

output "cloudfront_distribution_arn" {
  description = "Distribution ARN: IC-WBT's tiles bucket policy names it as AWS:SourceArn when Round 5 adds /tiles/* (data.md row 6)."
  value       = aws_cloudfront_distribution.frontend.arn
}

output "lambda_function_url" {
  description = "Direct Function URL, for debugging only: the shared-secret check rejects every request that skips CloudFront. Sensitive so export-tf-vars.sh doesn't publish it as a variable (it would become a GitHub secret, unused)."
  value       = aws_lambda_function_url.backend.function_url
  sensitive   = true
}
