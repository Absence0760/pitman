# ----------------------------------------------------------------------------
# Lambda execution role
# ----------------------------------------------------------------------------

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.project}-backend-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ----------------------------------------------------------------------------
# CloudWatch log group
# ----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.project}-backend"
  retention_in_days = var.lambda_log_retention_days
}

# ----------------------------------------------------------------------------
# Placeholder Lambda deployment package
#
# Terraform creates the Lambda with a stub. Real code is uploaded by the
# GitHub Actions deploy-backend workflow. The lifecycle block tells Terraform
# to ignore subsequent code changes so `apply` doesn't fight with CI.
# ----------------------------------------------------------------------------

data "archive_file" "lambda_stub" {
  type        = "zip"
  output_path = "${path.module}/.terraform/lambda_stub.zip"

  source {
    filename = "lambda.mjs"
    content  = <<-EOT
      export const handler = async () => ({
        statusCode: 503,
        body: JSON.stringify({ error: "Backend not yet deployed. Run the GitHub Actions deploy-backend workflow." })
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
  runtime = "nodejs20.x"
  timeout = 10

  memory_size = 512

  reserved_concurrent_executions = var.lambda_reserved_concurrency

  environment {
    variables = {
      ALLOWED_ORIGINS          = "https://${var.domain_name},https://www.${var.domain_name}"
      SITE_URL                 = var.site_url != "" ? var.site_url : "https://${var.domain_name}"
      CLOUDFRONT_SHARED_SECRET = random_password.cloudfront_shared_secret.result
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
    ]
  }
}

resource "aws_lambda_function_url" "backend" {
  function_name      = aws_lambda_function.backend.function_name
  authorization_type = "NONE"

  cors {
    allow_credentials = false
    allow_origins     = ["https://${var.domain_name}", "https://www.${var.domain_name}"]
    allow_methods     = ["POST", "GET", "OPTIONS"]
    allow_headers     = ["content-type"]
    max_age           = 600
  }
}
