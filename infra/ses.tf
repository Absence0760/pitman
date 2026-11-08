# ----------------------------------------------------------------------------
# Amazon SES: sign-in codes (issue #28, A-AUTH-7). Copied from WM
# infra/ses.tf, with feohledger infra/email.tf's sender layout (the estate
# pattern):
#
#   Identity:   pitman.jaredhoward.com     Easy DKIM (RSA 2048), 3 CNAMEs
#   From:       no-reply@<domain>          the only address the Lambda may use
#   MAIL FROM:  send.<domain>              MX -> feedback-smtp.<region>.amazonses.com,
#                                          SPF include:amazonses.com
#   DMARC:      _dmarc.<domain>            p=none to start (var.dmarc_policy)
#
# DKIM (d=<domain>) and SPF (the MAIL FROM is a subdomain, relaxed alignment)
# both align with the From domain. The site's zone holds no other mail records
# (no MX or SPF at the apex, no _dmarc), so nothing here collides; the parent
# jaredhoward.com's own _dmarc is overridden by this one for this subdomain.
#
# The Lambda sends with the SES v2 API through its own role: no SMTP password
# exists. SES lives in the primary region (af-south-1).
#
# NOT done here, by hand, once (docs/deployment.md § First deploy):
#   - asking AWS for production access (leaving the sandbox; a support review
#     that can take a day or more). In the SES sandbox a send to an
#     unverified recipient is refused (MessageRejected), and the users are
#     unverified addresses, so sign-in mail works only after production
#     access. The backend logs each refusal as `mail.send_failed`, which
#     alarms (alarms.tf).
#   - checking the identity has verified (DKIM SUCCESS) once the CNAMEs resolve.
# ----------------------------------------------------------------------------

locals {
  mail_from_address = "no-reply@${var.domain_name}"
  mail_from_domain  = "send.${var.domain_name}"

  # Easy DKIM CNAME target. Most regions share dkim.amazonses.com; the newer
  # opt-in regions, af-south-1 among them, use a regional domain (AWS General
  # Reference, SES endpoints, "DKIM domains"; WM ses.tf). Getting it wrong
  # leaves the identity stuck in PENDING.
  ses_regional_dkim_regions = [
    "af-south-1", "ap-south-2", "ap-southeast-3", "ap-southeast-5", "ca-west-1",
    "ap-northeast-3", "eu-south-1", "eu-central-2", "il-central-1", "me-central-1",
  ]
  ses_dkim_domain = contains(local.ses_regional_dkim_regions, var.aws_region) ? "dkim.${var.aws_region}.amazonses.com" : "dkim.amazonses.com"

  dmarc_record = join("; ", compact([
    "v=DMARC1",
    "p=${var.dmarc_policy}",
    var.dmarc_report_email != "" ? "rua=mailto:${var.dmarc_report_email}" : "",
    "adkim=r",
    "aspf=r",
  ]))

  # The event source mapping waits up to this long to fill a batch.
  mail_events_batching_window_seconds = 5

  # AWS's guidance for an SQS event source (Lambda DG, "Using Lambda with
  # Amazon SQS"): six times the function timeout plus the batching window,
  # so a message isn't redelivered while a slow batch is still running.
  mail_events_visibility_seconds = 6 * var.lambda_timeout_seconds + local.mail_events_batching_window_seconds
}

# --- Configuration set: TLS, suppression, reputation metrics ---------------
#
# No CloudWatch event destination: per-event SES metrics are billed as custom
# CloudWatch metrics (about $2/month for the seven event types) and no alarm
# would use them. The reputation alarms (alarms.tf) read the account-level
# Reputation.* metrics, which are free, and bounces and complaints reach the
# app through SNS (below).

resource "aws_sesv2_configuration_set" "main" {
  configuration_set_name = local.project

  delivery_options {
    # The mail carries a live sign-in code. REQUIRE refuses to hand it to a
    # receiving MX that can't do STARTTLS rather than send it in the clear.
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  # An address that hard-bounces or complains is never mailed again, which
  # keeps the account's sending rights. Removing one from the list
  # (ses:DeleteSuppressedDestination) is the operator's job, not the Lambda's.
  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

# --- Domain identity + Easy DKIM -------------------------------------------

resource "aws_sesv2_email_identity" "site" {
  email_identity         = var.domain_name
  configuration_set_name = aws_sesv2_configuration_set.main.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

# Easy DKIM always returns three tokens.
resource "aws_route53_record" "ses_dkim" {
  count   = 3
  zone_id = data.aws_route53_zone.site.zone_id
  name    = "${aws_sesv2_email_identity.site.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_sesv2_email_identity.site.dkim_signing_attributes[0].tokens[count.index]}.${local.ses_dkim_domain}"]
}

# --- Custom MAIL FROM (SPF alignment) --------------------------------------

resource "aws_sesv2_email_identity_mail_from_attributes" "site" {
  email_identity   = aws_sesv2_email_identity.site.email_identity
  mail_from_domain = local.mail_from_domain
  # If the send. MX ever goes missing, fall back to amazonses.com rather than
  # bouncing every code (DKIM still aligns, so DMARC still passes).
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_route53_record" "ses_mail_from_mx" {
  zone_id = data.aws_route53_zone.site.zone_id
  name    = local.mail_from_domain
  type    = "MX"
  ttl     = 1800
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]
}

resource "aws_route53_record" "ses_mail_from_spf" {
  zone_id = data.aws_route53_zone.site.zone_id
  name    = local.mail_from_domain
  type    = "TXT"
  ttl     = 1800
  records = ["v=spf1 include:amazonses.com -all"]
}

# --- DMARC -----------------------------------------------------------------

resource "aws_route53_record" "dmarc" {
  zone_id = data.aws_route53_zone.site.zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  ttl     = 1800
  records = [local.dmarc_record]
}

# --- IAM: the API Lambda may send, as no-reply@ only -----------------------
# SES v2 SendEmail authorises against the sending identity and the
# configuration set the message uses. Exactly those two ARNs, and only with
# From = no-reply@<domain>. In the SES sandbox a send to an unverified
# recipient is refused, so the first real sign-in waits for production access
# (WM widens its grant to identity/* for sandbox testing; A-AUTH-7 chose the
# identity only). Never granted: ses:DeleteSuppressedDestination (the
# operator's job, A-AUTH-7).
resource "aws_iam_role_policy" "lambda_ses_send" {
  name = "${local.project}-backend-ses-send"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "SendAsNoReplyOnly"
      Effect = "Allow"
      Action = ["ses:SendEmail"]
      Resource = [
        aws_sesv2_email_identity.site.arn,
        aws_sesv2_configuration_set.main.arn,
      ]
      Condition = {
        StringEquals = { "ses:FromAddress" = local.mail_from_address }
      }
    }]
  })
}

# --- Bounces and complaints -> the app ---------------------------------------
# The suppression list keeps SES from mailing a bounced or complaining address
# again, but on its own the app never knows. So both events are published to
# the API Lambda as well. Today it logs each one (`mail.bounce`,
# `mail.complaint`, no address); flagging the address on the Users page comes
# with auth-kit v0.2.0:
#
#   configuration set --BOUNCE, COMPLAINT--> SNS `pitman-ses-events`
#     --raw message delivery--> SQS `pitman-mail-events` (DLQ after 5 tries)
#       --event source mapping--> the API Lambda (lambda.ts tells an SQS
#                                 batch from an HTTP request)
#
# Trust runs down the chain: only SES, for this configuration set in this
# account, may publish to the topic; only the topic may send to the queue.
#
# The topic is not KMS-encrypted: SES can publish to an encrypted topic only
# through a customer-managed key whose policy admits it ($1/month and a key
# policy), and SNS keeps nothing at rest past delivery. The queues, where the
# events wait, are SSE-SQS encrypted.

#trivy:ignore:AVD-AWS-0095 SES event relay; nothing at rest past delivery, see above
resource "aws_sns_topic" "ses_events" {
  name = "${local.project}-ses-events"
}

resource "aws_sns_topic_policy" "ses_events" {
  arn = aws_sns_topic.ses_events.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SesPublishesThisConfigurationSetOnly"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "sns:Publish"
      Resource  = aws_sns_topic.ses_events.arn
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
        ArnEquals    = { "aws:SourceArn" = aws_sesv2_configuration_set.main.arn }
      }
    }]
  })
}

resource "aws_sesv2_configuration_set_event_destination" "suppression" {
  configuration_set_name = aws_sesv2_configuration_set.main.configuration_set_name
  event_destination_name = "suppression"

  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT"]

    sns_destination {
      topic_arn = aws_sns_topic.ses_events.arn
    }
  }

  # SES checks it may publish when the destination is created.
  depends_on = [aws_sns_topic_policy.ses_events]
}

resource "aws_sqs_queue" "mail_events_dlq" {
  name                      = "${local.project}-mail-events-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum: time to look
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "mail_events" {
  name                       = "${local.project}-mail-events"
  visibility_timeout_seconds = local.mail_events_visibility_seconds
  message_retention_seconds  = 345600 # 4 days
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.mail_events_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "mail_events_dlq" {
  queue_url = aws_sqs_queue.mail_events_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.mail_events.arn]
  })
}

# Only the ses-events topic may send here, and every request must be TLS
# (the same Deny as the sign-in mail queue's, mail_queue.tf).
resource "aws_sqs_queue_policy" "mail_events" {
  queue_url = aws_sqs_queue.mail_events.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "SesEventsTopicOnly"
        Effect    = "Allow"
        Principal = { Service = "sns.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.mail_events.arn
        Condition = {
          ArnEquals = { "aws:SourceArn" = aws_sns_topic.ses_events.arn }
        }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "sqs:*"
        Resource  = aws_sqs_queue.mail_events.arn
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      },
    ]
  })
}

resource "aws_sns_topic_subscription" "mail_events" {
  topic_arn = aws_sns_topic.ses_events.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.mail_events.arn
  # The SES event itself is the message body, not an SNS envelope.
  raw_message_delivery = true

  depends_on = [aws_sqs_queue_policy.mail_events]
}

# The event source mapping polls as the function's role: consume this queue
# only. No ChangeMessageVisibility (failed records are reported back, not
# re-timed) and no SendMessage.
resource "aws_iam_role_policy" "lambda_mail_events" {
  name = "${local.project}-backend-mail-events"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ConsumeMailEvents"
      Effect   = "Allow"
      Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      Resource = aws_sqs_queue.mail_events.arn
    }]
  })
}

# The same function as the API (lambda.ts dispatches an SQS batch to the
# bounce handler). At most 2 concurrent batches, counted inside the
# function's reserved concurrency (at least 5, variables.tf, so the mapping
# is never throttled by its own cap); only failed records are retried. A
# flood that holds every reserved copy busy throttles these polls too, and
# after 5 receives an event dead-letters (the DLQ alarm says how to redrive);
# the durable fix, if that ever bites, is a separate small function.
resource "aws_lambda_event_source_mapping" "mail_events" {
  event_source_arn                   = aws_sqs_queue.mail_events.arn
  function_name                      = aws_lambda_function.backend.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = local.mail_events_batching_window_seconds
  function_response_types            = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2
  }

  depends_on = [aws_iam_role_policy.lambda_mail_events]
}
