output "aws_region" {
  description = "AWS region — surfaced as a GitHub variable so the deploy workflow can read it."
  value       = var.aws_region
}

output "frontend_bucket" {
  description = "S3 bucket that hosts the built frontend. CI uploads to this bucket."
  value       = aws_s3_bucket.frontend.bucket
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID. CI uses this for cache invalidation."
  value       = aws_cloudfront_distribution.frontend.id
}

output "cloudfront_domain_name" {
  description = "The *.cloudfront.net domain, useful while DNS is propagating."
  value       = aws_cloudfront_distribution.frontend.domain_name
}

output "lambda_function_name" {
  description = "Lambda function name. CI uses this to update the function code."
  value       = aws_lambda_function.backend.function_name
}

output "public_api_url" {
  description = "Same-origin API base. Frontend hits /api/* on the CloudFront distribution; CloudFront proxies to the Lambda Function URL with the shared secret. Set as a build-time gh var so frontend code can read it via import.meta.env.PUBLIC_API_URL."
  value       = "https://${var.domain_name}/api"
}

output "lambda_function_url" {
  description = "Direct HTTPS URL of the backend Lambda Function URL. Provided for debugging; do NOT use from the frontend (the shared-secret check rejects un-stamped requests). Marked sensitive to discourage accidental gh-variable exposure."
  value       = aws_lambda_function_url.backend.function_url
  sensitive   = true
}

output "public_site_url" {
  description = "Public URL of the site."
  value       = "https://${var.domain_name}"
}

# Sensitive — embeds the AWS account ID. export-tf-vars.sh pushes sensitive
# outputs to GitHub *secrets*, read by deploy.yml as
# ${{ secrets.AWS_DEPLOY_ROLE_ARN }}.
output "aws_deploy_role_arn" {
  description = "ARN of the bootstrap-created deploy role that GitHub Actions assumes via OIDC."
  value       = data.aws_iam_role.github_deploy.arn
  sensitive   = true
}
