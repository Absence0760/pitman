# ----------------------------------------------------------------------------
# The sign-in mail queue (issue #30, A-AUTH-14). POST /auth/code no longer
# sends mail inside the request: it puts one sealed message on this queue
# (a listed address its code, an unlisted one a decoy of the same size) and
# answers, so its floor is auth-kit's 1 s default instead of SES's worst case.
# The same API Lambda consumes the queue and sends the email:
#
#   POST /auth/code --SendMessage--> SQS `pitman-mail-send` (DLQ after 3 tries)
#     --event source mapping--> the API Lambda (lambda.ts tells this queue's
#                               batches from the bounce queue's by ARN,
#                               against MAIL_QUEUE_URL) --SendEmail--> SES
#
# The body is sealed by the backend (AES-256-GCM under a key derived from
# AUTH_CODE_KEY, backend/src/auth/mailQueue.ts), so the queue, its DLQ, the
# console and a redrive never show an address or a code. That is why the
# queues are SSE-SQS rather than a customer KMS key: the key would add
# $1/month, a key policy and kms:Decrypt on the role to protect a body that is
# already ciphertext under a key only the function holds.
#
# Retention follows the code's life: a message older than its code (auth-kit's
# CODE_TTL_MS, 10 minutes) is worthless, so SQS deletes it then. With the
# visibility timeout at 6 x the Lambda timeout (AWS's SQS guidance, 180 s at
# the default 30 s), a refused send is tried at about 0, 3 and 6 minutes and
# dead-letters on the next receive, inside those 10 minutes. The DLQ keeps a
# message a day from when it was first sent (SQS counts a standard queue's
# retention from the original enqueue): long enough to see the alarm, short
# enough that no sealed address lingers (docs/security.md § Erasure).
# ----------------------------------------------------------------------------

locals {
  # auth-kit's CODE_TTL_MS, in seconds.
  mail_send_retention_seconds  = 600
  mail_send_visibility_seconds = 6 * var.lambda_timeout_seconds
  mail_send_max_receives       = 3
}

resource "aws_sqs_queue" "mail_send_dlq" {
  name                      = "${local.project}-mail-send-dlq"
  message_retention_seconds = 86400 # 1 day
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "mail_send" {
  name                       = "${local.project}-mail-send"
  visibility_timeout_seconds = local.mail_send_visibility_seconds
  message_retention_seconds  = local.mail_send_retention_seconds
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.mail_send_dlq.arn
    maxReceiveCount     = local.mail_send_max_receives
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "mail_send_dlq" {
  queue_url = aws_sqs_queue.mail_send_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.mail_send.arn]
  })
}

# No principal outside the account is granted anything (no Allow here); the
# one statement refuses any request not over TLS, from anyone.
resource "aws_sqs_queue_policy" "mail_send" {
  queue_url = aws_sqs_queue.mail_send.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "sqs:*"
      Resource  = aws_sqs_queue.mail_send.arn
      Condition = {
        Bool = { "aws:SecureTransport" = "false" }
      }
    }]
  })
}

# The API Lambda both enqueues (the request) and consumes (the mapping, which
# polls as the function's role) this queue, and nothing else. No
# ChangeMessageVisibility (failed records are reported back, not re-timed),
# no access to the DLQ (redrive is the operator's, from the console).
resource "aws_iam_role_policy" "lambda_mail_send" {
  name = "${local.project}-backend-mail-send"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EnqueueSignInMail"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.mail_send.arn
      },
      {
        Sid      = "ConsumeSignInMail"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.mail_send.arn
      },
    ]
  })
}

# No batching window: a code should arrive in seconds, and a batch of one is
# as cheap as a batch of ten at this volume. The worker sends a batch's
# records at once, so a batch lasts one SES worst case (4 s,
# SES_SEND_WORST_CASE_MS), well inside the function's timeout. At most 2
# batches at once, inside the function's reserved concurrency (at least 5,
# variables.tf); with the bounce queue's mapping that is at most 4 copies on
# queues, leaving one for the API in the worst case.
resource "aws_lambda_event_source_mapping" "mail_send" {
  event_source_arn                   = aws_sqs_queue.mail_send.arn
  function_name                      = aws_lambda_function.backend.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 0
  function_response_types            = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2
  }

  depends_on = [aws_iam_role_policy.lambda_mail_send]
}
