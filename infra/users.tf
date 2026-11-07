# ----------------------------------------------------------------------------
# User list (issue #28, A-AUTH-4): one DynamoDB table in the primary region
# (af-south-1, A-AUTH-6), auth-kit's single-table item design:
#
#   USER#<id>, EMAIL#<email>, META#admins    the list and its invariants
#   CODE#<hmac>, THROTTLE#<hmac>             sign-in codes and send limits (TTL)
#   REVOKED#<jti>                            signed-out sessions (TTL)
#   AUDIT#...                                every change and sign-in (TTL,
#                                            var.audit_retention_months)
#
# Expiry that matters (a code's 10 minutes) is checked in code; TTL only
# cleans up, up to a couple of days late.
#
# The first admin is never created here: `pnpm admin:bootstrap` writes it with
# the operator's credentials, so no address ever lands in Terraform state.
#
# Cost: on-demand, a handful of users; cents a month. PITR is $0.20 per GB-month
# of a table measured in kilobytes.
# ----------------------------------------------------------------------------

# Encryption: the AWS-owned key (server_side_encryption omitted = DynamoDB's
# default). A customer key costs $1/month and adds a key policy for a table
# whose only personal data is a short list of work addresses; the AWS-managed
# alias/aws/dynamodb key adds KMS calls on every read for no extra control.
#trivy:ignore:AVD-AWS-0025 AWS-owned key by choice; see above
resource "aws_dynamodb_table" "users" {
  name         = "${local.project}-users"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  # A `terraform destroy` (or a rename that forces replacement) must not take
  # the user list with it. Turn this off by hand, deliberately, to remove it.
  deletion_protection_enabled = true

  tags = {
    AuditRetentionMonths = tostring(var.audit_retention_months)
  }
}

# The API Lambda's access: exactly auth-kit's DYNAMODB_IAM_ACTIONS, on this
# table's ARN only. TransactWriteItems has no IAM action of its own: each item
# in a transaction is authorised as the matching Put/Update/Delete/
# ConditionCheckItem. No Scan, no Batch*, no index ARN (the table has no
# indexes), no stream.
resource "aws_iam_role_policy" "lambda_users_table" {
  name = "${local.project}-backend-users-table"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "UsersTable"
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:Query",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:ConditionCheckItem",
      ]
      Resource = aws_dynamodb_table.users.arn
    }]
  })
}

# ----------------------------------------------------------------------------
# Sign-in keys (A-AUTH-8). Generated once, in state only (encrypted S3, this
# account); nobody handles them. Two separate values: the code HMAC key and
# the session-signing key, so one leaking or rotating doesn't touch the other.
# Rotate with `terraform apply -replace=random_password.auth_session_key`
# (signs everyone out) or `-replace=random_password.auth_code_key` (voids
# codes in flight). docs/deployment.md § Secrets.
# ----------------------------------------------------------------------------

resource "random_password" "auth_code_key" {
  length  = 48
  special = false
}

resource "random_password" "auth_session_key" {
  length  = 48
  special = false
}
