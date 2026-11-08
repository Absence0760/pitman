# ----------------------------------------------------------------------------
# Optional: CloudFront's flat-rate Pro plan (R4-I15). Off by default
# (cloudfront_flat_rate_plan = "none"): Pitman runs pay-as-you-go, with the
# breaker and the alarms (breaker.tf, alarms.tf) as its spend guard.
#
# Pro is $15 a month for the distribution, its web ACL (the $5 ACL, $1 a
# rule and the request fees) and, attached, the Route 53 zone, with no
# overage charges whatever the traffic; requests the WAF blocks don't count
# towards the allowance (10 M requests, 50 TB). It turns the two lines
# nothing caps on pay-as-you-go, the edge and DNS (infra/README.md § Cost),
# into a fixed cost. Source: CloudFront Developer Guide, "CloudFront
# flat-rate pricing plans".
#
# approval_mode = "MANUAL", always: the subscription is created in
# PENDING_APPROVAL, unbilled and unmodifiable, and only the operator's
# approval in the CloudFront console (a billing decision) starts it. So an
# apply with "PRO" asks AWS only whether it accepts this configuration
# (CreateSubscription fails with a ValidationException on an ineligible one,
# and `status` / `status_reason` say what it made of it);
# docs/deployment.md § Then: the flat-rate plan is the procedure.
#
# Never `terraform import` an existing subscription into this resource:
# approval_mode is not returned by AWS and forces a new resource, so the
# plan after an import replaces it, cancelling a paid subscription
# (hashicorp/terraform-provider-aws#50494). Create it from here, or leave
# a console-made one outside Terraform.
#
# While the plan covers the distribution, AWS blocks deleting the
# distribution and removing or replacing its web ACL, and the hosted zone
# can't be deleted, until a cancellation takes effect at the end of the
# billing cycle. Setting "none" again destroys this resource, which cancels
# the plan at the end of the cycle (a PENDING_APPROVAL one is deleted at once).
#
# Unconfirmed compatibility (AWS's answer to the PRO apply settles each):
#   - Pro allows only default (AWS-managed) origin request rules. /api/*
#     uses the managed AllViewerExceptHostHeader policy, but its origin also
#     carries a custom origin header (X-CloudFront-Shared-Secret,
#     s3_cloudfront.tf); whether that counts as a custom rule isn't said.
#   - A Lambda Function URL origin behind a `lambda` OAC isn't mentioned in
#     the plan's documentation (S3 OAC is the example it gives).
#   - Caching: both behaviours use managed cache policies
#     (Managed-CachingOptimized, Managed-CachingDisabled), which is what
#     "default caching rules" below Business should mean.
#   - A plan covers "up to one apex (root) domain"; Pitman is the subdomain
#     pitman.jaredhoward.com in its own delegated zone.
#   - An account "using AWS Free Tier" isn't eligible.
# Already compatible: no response headers policy (R4-I14), no
# ForwardedValues, OAC not OAI, no WAF rule groups, no real-time logs, one
# distribution per function and per web ACL.
# ----------------------------------------------------------------------------

resource "aws_pricingplanmanager_subscription" "cloudfront" {
  count = var.cloudfront_flat_rate_plan == "none" ? 0 : 1

  # Pricing Plan Manager is global, served from us-east-1 (the provider pins
  # it there whatever the region; the alias says so).
  provider = aws.us_east_1

  plan_family   = "CloudFront"
  plan_tier     = var.cloudfront_flat_rate_plan
  approval_mode = "MANUAL"

  # Exactly one distribution and one web ACL, plus the zone: it is in this
  # account (the bootstrap's, s3_cloudfront.tf) and covers the domain, so
  # its hosted-zone fee and DNS queries come under the plan too (Pro: 100
  # records, 5 M non-alias queries a month).
  resource_arns = [
    aws_cloudfront_distribution.frontend.arn,
    aws_wafv2_web_acl.frontend.arn,
    data.aws_route53_zone.site.arn,
  ]
}
