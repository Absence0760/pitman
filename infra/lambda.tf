# ----------------------------------------------------------------------------
# API Lambda (Hono, backend/src/lambda.ts) — Round 4.2's data API:
# quaternaries, CHIRPS monthly totals, the MAP-grid mean; Round 5 adds
# delineation, which is why memory and timeout are sized for it now.
#
# Cost bound: reserved concurrency x memory x timeout. At the defaults
# (10 x 1 GB, arm64 at af-south-1's ~$0.0000177 per GB-second) a flood that
# keeps every copy busy costs ~$0.0002 a second (~$15 a day) plus requests;
# the WAF's /api/* rate rule, the invocation
# alarm and the budget (alarms.tf) are the layers in front of that.
# ----------------------------------------------------------------------------

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    # Only this account's Lambda service may assume it (confused deputy).
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.project}-backend-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

# Logs: its own log group only (not the managed AWSLambdaBasicExecutionRole,
# which allows logs:CreateLogGroup and PutLogEvents on every group).
resource "aws_iam_role_policy" "lambda_logs" {
  name = "${local.project}-backend-logs"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "OwnLogGroup"
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.lambda.arn}:*"
    }]
  })
}

# ----------------------------------------------------------------------------
# Cross-account read of IC-WBT's buckets (docs/data.md § Cross-account
# access, rows 1, 2 and 5). This is the identity half; IC-WBT's bucket
# policies (Round 4.1, a PR in project-water-management) are the other half,
# naming this role's exact ARN (output lambda_role_arn). Both are needed.
#
# Every statement is conditioned on s3:ResourceAccount = IC-WBT's account, so
# a bucket of the same name anywhere else is never readable. All three
# buckets are SSE-S3: no KMS grant. Statements appear only once their
# variables are set, so the stack applies before 4.1 exists.
#
# Rows 3, 4 and 6 (DEM, water occurrence, the browser's tiles through
# CloudFront) are Round 5 and 7; add them then.
# ----------------------------------------------------------------------------

locals {
  chirps_enabled   = var.icwbt_account_id != "" && var.chirps_bucket != ""
  map_grid_enabled = var.icwbt_account_id != "" && var.map_grid_bucket != "" && var.map_grid_key != ""

  icwbt_account_condition = {
    StringEquals = { "s3:ResourceAccount" = var.icwbt_account_id }
  }

  # Each statement is JSON-encoded with its switch, so statements of
  # different shapes can be filtered (a conditional can't return tuples of
  # different lengths); keyed by Sid.
  cross_account_candidates = {
    # Row 1: the CHIRPS store's objects (and the root group metadata).
    ChirpsRead = {
      enabled = local.chirps_enabled
      json = jsonencode({
        Sid    = "ChirpsRead"
        Effect = "Allow"
        Action = ["s3:GetObject"]
        Resource = concat(
          ["arn:aws:s3:::${var.chirps_bucket}/${var.chirps_prefix}/*"],
          var.chirps_root_metadata ? ["arn:aws:s3:::${var.chirps_bucket}/zarr.json"] : [],
        )
        Condition = local.icwbt_account_condition
      })
    }
    # Row 2: list, only under the prefix, so a never-written (all-NaN) chunk
    # answers 404 rather than 403 (data.md, 'Why ListBucket').
    ChirpsListPrefix = {
      enabled = local.chirps_enabled
      json = jsonencode({
        Sid      = "ChirpsListPrefix"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = ["arn:aws:s3:::${var.chirps_bucket}"]
        Condition = merge(local.icwbt_account_condition, {
          StringLike = { "s3:prefix" = ["${var.chirps_prefix}/*"] }
        })
      })
    }
    # Row 5: the one MAP-grid file, by exact key.
    MapGridRead = {
      enabled = local.map_grid_enabled
      json = jsonencode({
        Sid       = "MapGridRead"
        Effect    = "Allow"
        Action    = ["s3:GetObject"]
        Resource  = ["arn:aws:s3:::${var.map_grid_bucket}/${var.map_grid_key}"]
        Condition = local.icwbt_account_condition
      })
    }
  }

  cross_account_statements = [for sid, s in local.cross_account_candidates : jsondecode(s.json) if s.enabled]
}

resource "aws_iam_role_policy" "lambda_cross_account_read" {
  count = length(local.cross_account_statements) > 0 ? 1 : 0
  name  = "${local.project}-backend-icwbt-read"
  role  = aws_iam_role.lambda.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = local.cross_account_statements
  })
}

# ----------------------------------------------------------------------------
# Log group
# ----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.project}-backend"
  retention_in_days = var.lambda_log_retention_days
}

# ----------------------------------------------------------------------------
# Function. Terraform creates it with a stub that answers 503; the real code
# comes from deploy-backend.yml (update-function-code), and ignore_changes
# keeps `apply` from fighting CI over it.
# ----------------------------------------------------------------------------

data "archive_file" "lambda_stub" {
  type        = "zip"
  output_path = "${path.module}/.terraform/lambda_stub.zip"

  source {
    filename = "lambda.mjs"
    content  = <<-EOT
      export const handler = async () => ({
        statusCode: 503,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Backend not yet deployed. Run the deploy-backend workflow." })
      });
    EOT
  }
}

resource "aws_lambda_function" "backend" {
  function_name = "${local.project}-backend"
  role          = aws_iam_role.lambda.arn

  filename         = data.archive_file.lambda_stub.output_path
  source_code_hash = data.archive_file.lambda_stub.output_base64sha256

  handler = "lambda.handler"
  # nodejs20.x reached end of support in April 2026. arm64: the bundle is pure
  # JavaScript (esbuild, no native modules) and Graviton is ~20 % cheaper.
  runtime       = "nodejs24.x"
  architectures = ["arm64"]

  memory_size = var.lambda_memory_mb
  timeout     = var.lambda_timeout_seconds

  reserved_concurrent_executions = var.lambda_reserved_concurrency

  # JSON logs, so the platform's START/END/REPORT lines (three per
  # invocation, about $50 a month of ingestion at the concurrency ceiling)
  # can be dropped: system logs at WARN keep only platform warnings and
  # errors (a timeout, an init failure). The backend logs with console.log
  # (INFO) and console.error (ERROR), so INFO keeps every line it writes;
  # never raise application_log_level above INFO, or the log-line alarms
  # (auth.locked, mail.send_failed and the rest) go silent. Their
  # quoted-term filters match inside the JSON `message` field (alarms.tf).
  logging_config {
    log_format            = "JSON"
    application_log_level = "INFO"
    system_log_level      = "WARN"
    log_group             = aws_cloudwatch_log_group.lambda.name
  }

  # What each variable means: docs/deployment.md § Lambda environment.
  environment {
    variables = {
      ALLOWED_ORIGINS          = "https://${var.domain_name}"
      SITE_URL                 = "https://${var.domain_name}"
      CLOUDFRONT_SHARED_SECRET = random_password.cloudfront_shared_secret.result
      CHIRPS_SOURCE            = local.chirps_enabled ? "s3" : ""
      CHIRPS_BUCKET            = local.chirps_enabled ? var.chirps_bucket : ""
      CHIRPS_PREFIX            = var.chirps_prefix
      MAP_GRID_SOURCE          = local.map_grid_enabled ? "s3://${var.map_grid_bucket}/${var.map_grid_key}" : ""
      # The S3 client's region for IC-WBT's buckets, passed explicitly
      # (data.md: IC-WBT's `new S3Client({})` would take the Lambda's own).
      # Its own variable, not aws_region: the buckets stay where IC-WBT keeps
      # them wherever Pitman runs.
      DATA_REGION = var.icwbt_region

      # Users and sign-in (issue #28; docs/deployment.md § Lambda environment).
      # The two keys are random_password values (users.tf), in state only.
      USER_STORE            = "dynamodb"
      USERS_TABLE           = aws_dynamodb_table.users.name
      AUTH_CODE_KEY         = random_password.auth_code_key.result
      AUTH_SESSION_KEY      = random_password.auth_session_key.result
      MAIL_TRANSPORT        = "ses"
      MAIL_FROM             = local.mail_from_address
      SES_CONFIGURATION_SET = aws_sesv2_configuration_set.main.configuration_set_name
      # POST /auth/code enqueues the email here; the same function sends it
      # (issue #30, mail_queue.tf). lambda.ts also dispatches on this URL.
      MAIL_QUEUE     = "sqs"
      MAIL_QUEUE_URL = aws_sqs_queue.mail_send.url
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy.lambda_logs]

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
    ]
  }
}

# The browser never calls the Function URL: it calls the site's own /api/*,
# and CloudFront proxies here (s3_cloudfront.tf), so there is no `cors` block
# (Hono's cors() is the only CORS layer, and every request is same-origin).
#
# AWS_IAM (issue #33, decision R4-I6): only SigV4-signed requests get in, and
# the only signer allowed is CloudFront's origin access control for this
# distribution (aws_cloudfront_origin_access_control.api and the two
# aws_lambda_permission statements, all in s3_cloudfront.tf). A call that
# skips CloudFront is refused by Lambda's front end with 403 before the
# function runs: never billed, never past the WAF. The app's shared-secret
# check stays behind it as a second layer.
#
# The provider adds public-invoke statements only when it *creates* a NONE
# URL; an AWS_IAM URL gets none, and changing the type in place removes none
# (docs/deployment.md § Lambda origin access control).
resource "aws_lambda_function_url" "backend" {
  function_name      = aws_lambda_function.backend.function_name
  authorization_type = "AWS_IAM"
}
