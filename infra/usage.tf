# ----------------------------------------------------------------------------
# Usage table: per-user quotas on the costly routes (pre-first-deploy cost
# audit, 2026-11-07; decision R4-I9). The per-client rate limits are counted
# per Lambda instance (R4-D4), so ten copies allow ten times as much, and
# varying the polygon defeats the result caches: one session could hold every
# copy busy on CHIRPS reads billed to IC-WBT. A durable counter per user
# bounds that across instances.
#
# The contract the backend writes against (backend/src, USAGE_STORE=dynamodb):
#   - hash key `pk` (S) only, no sort key, no index;
#   - TTL on `expires_at` (N, epoch seconds), so a counter's window cleans
#     itself up;
#   - the Lambda may only dynamodb:UpdateItem on this table (a conditional
#     ADD per counted request, its result from ReturnValues), never read,
#     scan or delete.
#
# Separate from the user table so a quota flood can't throttle sign-in and
# the gate, and so its tiny caps bound its own bill.
#
# Cost: one write unit per counted request (items well under 1 KB); cents a
# month for a handful of users. Ceiling at the caps below:
#   writes 10 x 2 592 000 s = 25.92 M x $0.84 per million = $21.77
#   reads   5 x 2 592 000 s = 12.96 M x $0.168 per million = $2.18
# so $23.95 a month, and UpdateItem uses write units only.
# ----------------------------------------------------------------------------

# Encryption at rest is on, under the AWS-owned key, as the user table
# (users.tf): counters keyed by an opaque user id hold nothing a customer key
# would protect better, and the AWS-managed key adds KMS calls per request.
# No PITR: a counter lost to a mistake resets a quota window, nothing more.
#trivy:ignore:AVD-AWS-0024 counters only; restoring them has no value
#trivy:ignore:AVD-AWS-0025 AWS-owned key by choice; see above
resource "aws_dynamodb_table" "usage" {
  name         = "${local.project}-usage"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  # What on-demand will serve and bill. 10 counted requests a second is far
  # beyond a handful of hydrologists (each counted request takes seconds of
  # Lambda); a flood throttles here and the usage-table alarm fires.
  on_demand_throughput {
    max_read_request_units  = 5
    max_write_request_units = 10
  }

  attribute {
    name = "pk"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = false
  }
}

resource "aws_iam_role_policy" "lambda_usage_table" {
  name = "${local.project}-backend-usage-table"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "UsageTable"
      Effect   = "Allow"
      Action   = "dynamodb:UpdateItem"
      Resource = aws_dynamodb_table.usage.arn
    }]
  })
}

# Throttles on the usage table: a flood at its write cap, or real use
# outgrowing it. UpdateItem is the only operation the Lambda makes here.
resource "aws_cloudwatch_metric_alarm" "usage_table_throttles" {
  alarm_name          = "${local.project}-usage-table-throttles"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ThrottledRequests"
  namespace           = "AWS/DynamoDB"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "The usage table (per-user quotas) throttled requests in the last 5 minutes: the costly routes are being refused. A flood at its 10 write units a second, or real use that has outgrown the cap (usage.tf)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    TableName = aws_dynamodb_table.usage.name
    Operation = "UpdateItem"
  }
}
