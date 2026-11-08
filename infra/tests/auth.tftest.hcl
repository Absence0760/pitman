# Credential-free tests of the users-and-sign-in infrastructure (issue #28 P2):
# the region refusal (A-AUTH-6), the user table's protections (A-AUTH-4), the
# Lambda's exact grants on the table, SES and the mail-events queue (A-AUTH-7),
# the sign-in mail queue (issue #30, A-AUTH-14),
# the sign-in keys (A-AUTH-8), the edge (A-AUTH-3, A-AUTH-9) and the alarms.
#   terraform -chdir=infra init -backend=false && terraform -chdir=infra test
#
# Mocked providers, `command = plan`, no AWS account, no state. The mocks
# below fill computed values (an identity's ARN, a password's result) during
# plan (`override_during = plan`), so grants can be compared ARN for ARN.
# Mocks are per resource type, so two resources of one type (the queue and
# its DLQ, the SES-events topic and the alert topics, the two sign-in keys)
# would share a value and an ARN mix-up between them would pass; the
# override_resource blocks after the providers give each its own.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111111111111"
    }
  }
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_data "aws_iam_role" {
    defaults = {
      arn  = "arn:aws:iam::111111111111:role/pitman-deploy"
      name = "pitman-deploy"
    }
  }
  mock_resource "aws_sesv2_email_identity" {
    override_during = plan
    defaults = {
      arn = "arn:aws:ses:af-south-1:111111111111:identity/pitman.jaredhoward.com"
      dkim_signing_attributes = {
        tokens                  = ["tokena", "tokenb", "tokenc"]
        next_signing_key_length = "RSA_2048_BIT"
      }
    }
  }
  mock_resource "aws_sesv2_configuration_set" {
    override_during = plan
    defaults = {
      arn = "arn:aws:ses:af-south-1:111111111111:configuration-set/pitman"
    }
  }
  mock_resource "aws_dynamodb_table" {
    override_during = plan
    defaults = {
      arn = "arn:aws:dynamodb:af-south-1:111111111111:table/pitman-users"
    }
  }
  mock_resource "aws_sqs_queue" {
    override_during = plan
    defaults = {
      arn = "arn:aws:sqs:af-south-1:111111111111:unexpected-queue"
      id  = "https://sqs.af-south-1.amazonaws.com/111111111111/unexpected-queue"
    }
  }
  mock_resource "aws_iam_role" {
    override_during = plan
    defaults = {
      id  = "pitman-backend-lambda"
      arn = "arn:aws:iam::111111111111:role/pitman-backend-lambda"
    }
  }
  mock_resource "aws_lambda_function" {
    override_during = plan
    defaults = {
      arn = "arn:aws:lambda:af-south-1:111111111111:function:pitman-backend"
    }
  }
  mock_resource "aws_cloudwatch_log_group" {
    override_during = plan
    defaults = {
      arn = "arn:aws:logs:af-south-1:111111111111:log-group:/aws/lambda/pitman-backend"
    }
  }
  mock_resource "aws_sns_topic" {
    override_during = plan
    defaults = {
      arn = "arn:aws:sns:af-south-1:111111111111:unexpected-topic"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
}

mock_provider "random" {
  mock_resource "random_password" {
    override_during = plan
  }
}
mock_provider "archive" {}

# alert_email is required (variables.tf); a real-looking address so every run
# plans. Runs that test its validation override it.
variables {
  alert_email = "alerts@pitman.jaredhoward.com"
}

# One distinct value per resource where a type has more than one.
override_resource {
  target          = aws_sqs_queue.mail_events
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:111111111111:pitman-mail-events"
    id  = "https://sqs.af-south-1.amazonaws.com/111111111111/pitman-mail-events"
  }
}

override_resource {
  target          = aws_sqs_queue.mail_events_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:111111111111:pitman-mail-events-dlq"
    id  = "https://sqs.af-south-1.amazonaws.com/111111111111/pitman-mail-events-dlq"
  }
}

override_resource {
  target          = aws_sqs_queue.mail_send
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:111111111111:pitman-mail-send"
    id  = "https://sqs.af-south-1.amazonaws.com/111111111111/pitman-mail-send"
    url = "https://sqs.af-south-1.amazonaws.com/111111111111/pitman-mail-send"
  }
}

override_resource {
  target          = aws_sqs_queue.mail_send_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:111111111111:pitman-mail-send-dlq"
    id  = "https://sqs.af-south-1.amazonaws.com/111111111111/pitman-mail-send-dlq"
    url = "https://sqs.af-south-1.amazonaws.com/111111111111/pitman-mail-send-dlq"
  }
}

override_resource {
  target          = aws_sns_topic.ses_events
  override_during = plan
  values = {
    arn = "arn:aws:sns:af-south-1:111111111111:pitman-ses-events"
  }
}

override_resource {
  target          = aws_sns_topic.alerts
  override_during = plan
  values = {
    arn = "arn:aws:sns:af-south-1:111111111111:pitman-alerts"
  }
}

override_resource {
  target          = aws_sns_topic.alerts_us_east_1
  override_during = plan
  values = {
    arn = "arn:aws:sns:us-east-1:111111111111:pitman-alerts"
  }
}

override_resource {
  target          = random_password.auth_code_key
  override_during = plan
  values = {
    result = "mock-code-key-mock-code-key-mock-code-key-mock-c"
  }
}

override_resource {
  target          = random_password.auth_session_key
  override_during = plan
  values = {
    result = "mock-session-key-mock-session-key-mock-session-"
  }
}

override_resource {
  target          = random_password.cloudfront_shared_secret
  override_during = plan
  values = {
    result = "mock-cloudfront-secret-mock-cloudfront-secret-mo"
  }
}

# --- region tied to the privacy notice (A-AUTH-6) -----------------------------

run "region_af_south_1_accepted" {
  command = plan

  assert {
    condition     = var.aws_region == "af-south-1" && !var.data_outside_south_africa
    error_message = "The default is af-south-1 with data_outside_south_africa off."
  }
}

run "region_elsewhere_refused" {
  command = plan
  variables {
    aws_region = "eu-west-1"
  }
  expect_failures = [var.aws_region]
}

run "region_elsewhere_allowed_with_flag" {
  command = plan
  variables {
    aws_region                = "eu-west-1"
    data_outside_south_africa = true
  }

  assert {
    condition     = var.aws_region == "eu-west-1"
    error_message = "With data_outside_south_africa = true another region must be accepted."
  }
}

# --- the user table (A-AUTH-4) ------------------------------------------------

run "users_table_protections" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.users.name == "pitman-users"
    error_message = "The table is pitman-users."
  }
  assert {
    condition     = aws_dynamodb_table.users.billing_mode == "PAY_PER_REQUEST"
    error_message = "The table is on-demand."
  }
  assert {
    condition     = aws_dynamodb_table.users.hash_key == "pk" && aws_dynamodb_table.users.range_key == "sk"
    error_message = "Keys are pk (hash) and sk (range)."
  }
  assert {
    condition     = toset([for a in aws_dynamodb_table.users.attribute : "${a.name}:${a.type}"]) == toset(["pk:S", "sk:S"])
    error_message = "pk and sk are strings, and no other attribute (no index) is declared."
  }
  assert {
    condition     = aws_dynamodb_table.users.point_in_time_recovery[0].enabled
    error_message = "PITR must be on."
  }
  assert {
    condition     = aws_dynamodb_table.users.ttl[0].enabled && aws_dynamodb_table.users.ttl[0].attribute_name == "ttl"
    error_message = "TTL must be on, on the attribute ttl."
  }
  assert {
    condition     = aws_dynamodb_table.users.deletion_protection_enabled
    error_message = "Deletion protection must be on."
  }
  assert {
    condition     = length(aws_dynamodb_table.users.global_secondary_index) == 0 && length(aws_dynamodb_table.users.local_secondary_index) == 0
    error_message = "The table has no indexes (the grant covers the table ARN only)."
  }
  assert {
    condition     = aws_dynamodb_table.users.tags["AuditRetentionMonths"] == "24"
    error_message = "Audit retention is recorded as 24 months."
  }
}

run "audit_retention_other_than_24_refused" {
  command = plan
  variables {
    audit_retention_months = 12
  }
  expect_failures = [var.audit_retention_months]
}

run "users_table_grant_is_exact" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.lambda_users_table.policy).Statement) == 1
    error_message = "One statement on the table."
  }
  assert {
    condition = sort(jsondecode(aws_iam_role_policy.lambda_users_table.policy).Statement[0].Action) == sort([
      "dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem",
      "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem",
    ])
    error_message = "Exactly auth-kit's six actions: no Scan, no Batch*, no wildcard."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.lambda_users_table.policy).Statement[0].Resource == aws_dynamodb_table.users.arn
    error_message = "The grant is on exactly the table ARN (no index/* or stream ARN)."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.lambda_users_table.policy).Statement[0].Effect == "Allow" && !can(jsondecode(aws_iam_role_policy.lambda_users_table.policy).Statement[0].Condition)
    error_message = "A plain Allow, nothing else."
  }
  assert {
    condition     = aws_iam_role_policy.lambda_users_table.role == aws_iam_role.lambda.id
    error_message = "The grant is on the API Lambda's role."
  }
}

# The usage table (per-user quotas, R4-I9): UpdateItem only, on that table only.
run "usage_table_grant_is_exact" {
  command = plan

  override_resource {
    target          = aws_dynamodb_table.usage
    override_during = plan
    values = {
      arn = "arn:aws:dynamodb:af-south-1:111111111111:table/pitman-usage"
    }
  }

  assert {
    condition = jsondecode(aws_iam_role_policy.lambda_usage_table.policy).Statement == [{
      Sid      = "UsageTable"
      Effect   = "Allow"
      Action   = "dynamodb:UpdateItem"
      Resource = "arn:aws:dynamodb:af-south-1:111111111111:table/pitman-usage"
    }]
    error_message = "One plain Allow of dynamodb:UpdateItem on the usage table's ARN: no read, scan, delete, or the user table."
  }
  assert {
    condition     = aws_iam_role_policy.lambda_usage_table.role == aws_iam_role.lambda.id
    error_message = "The grant is on the API Lambda's role."
  }
}

# --- SES (A-AUTH-7) ---------------------------------------------------------------

run "ses_sender" {
  command = plan

  assert {
    condition     = aws_sesv2_email_identity.site.email_identity == "pitman.jaredhoward.com"
    error_message = "The SES identity is the site domain."
  }
  assert {
    condition     = aws_sesv2_email_identity_mail_from_attributes.site.mail_from_domain == "send.pitman.jaredhoward.com"
    error_message = "MAIL FROM is send.<domain> (the estate pattern)."
  }
  assert {
    condition     = aws_route53_record.ses_mail_from_mx.records == toset(["10 feedback-smtp.af-south-1.amazonses.com"])
    error_message = "The MAIL FROM MX points at SES's feedback host in af-south-1."
  }
  assert {
    condition     = aws_route53_record.ses_dkim[0].records == toset(["tokena.dkim.af-south-1.amazonses.com"])
    error_message = "af-south-1 uses the regional DKIM domain."
  }
  assert {
    condition     = one(aws_route53_record.dmarc.records) == "v=DMARC1; p=none; adkim=r; aspf=r"
    error_message = "DMARC starts at p=none."
  }
  assert {
    condition     = aws_sesv2_configuration_set.main.delivery_options[0].tls_policy == "REQUIRE"
    error_message = "The configuration set requires TLS."
  }
  assert {
    condition     = toset(aws_sesv2_configuration_set.main.suppression_options[0].suppressed_reasons) == toset(["BOUNCE", "COMPLAINT"])
    error_message = "Suppression covers bounces and complaints."
  }
  assert {
    condition     = aws_sesv2_configuration_set.main.reputation_options[0].reputation_metrics_enabled
    error_message = "Reputation metrics are on."
  }
  assert {
    condition     = toset(aws_sesv2_configuration_set_event_destination.suppression.event_destination[0].matching_event_types) == toset(["BOUNCE", "COMPLAINT"])
    error_message = "Bounces and complaints go to the SNS topic."
  }
}

run "ses_grant_is_exact" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.lambda_ses_send.policy).Statement) == 1
    error_message = "One SES statement."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.lambda_ses_send.policy).Statement[0].Action == ["ses:SendEmail"]
    error_message = "ses:SendEmail only."
  }
  assert {
    condition = toset(jsondecode(aws_iam_role_policy.lambda_ses_send.policy).Statement[0].Resource) == toset([
      aws_sesv2_email_identity.site.arn, aws_sesv2_configuration_set.main.arn,
    ])
    error_message = "SendEmail is granted on the domain identity and the configuration set only."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.lambda_ses_send.policy).Statement[0].Condition.StringEquals["ses:FromAddress"] == "no-reply@pitman.jaredhoward.com"
    error_message = "Sending is conditioned on From = no-reply@<domain>."
  }
  assert {
    condition = !anytrue([
      for p in [
        aws_iam_role_policy.lambda_logs.policy,
        aws_iam_role_policy.lambda_users_table.policy,
        aws_iam_role_policy.lambda_ses_send.policy,
        aws_iam_role_policy.lambda_mail_events.policy,
        aws_iam_role_policy.lambda_mail_send.policy,
        aws_iam_role_policy.lambda_usage_table.policy,
      ] : strcontains(p, "DeleteSuppressedDestination") || strcontains(p, "ses:*") || strcontains(p, "\"*\"")
    ])
    error_message = "No Lambda policy grants ses:DeleteSuppressedDestination, ses:* or a bare * (removing a suppression is the operator's job)."
  }
}

run "mail_events_chain" {
  command = plan

  assert {
    condition     = aws_sqs_queue.mail_events.arn != aws_sqs_queue.mail_events_dlq.arn && aws_sns_topic.ses_events.arn != aws_sns_topic.alerts.arn
    error_message = "Test harness: the queue and its DLQ, and the SES-events and alert topics, must have distinct mock ARNs, or the pins below can't tell them apart."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.lambda_mail_events.policy).Statement[0].Resource == "arn:aws:sqs:af-south-1:111111111111:pitman-mail-events"
    error_message = "The Lambda consumes the mail-events queue only (not its DLQ)."
  }
  assert {
    condition     = aws_lambda_event_source_mapping.mail_events.event_source_arn == "arn:aws:sqs:af-south-1:111111111111:pitman-mail-events"
    error_message = "The event source mapping polls the mail-events queue, not its DLQ."
  }
  assert {
    condition     = jsondecode(aws_sqs_queue.mail_events.redrive_policy).deadLetterTargetArn == "arn:aws:sqs:af-south-1:111111111111:pitman-mail-events-dlq"
    error_message = "The queue dead-letters into the mail-events DLQ."
  }
  assert {
    condition     = jsondecode(aws_sqs_queue_redrive_allow_policy.mail_events_dlq.redrive_allow_policy).sourceQueueArns == ["arn:aws:sqs:af-south-1:111111111111:pitman-mail-events"] && aws_sqs_queue_redrive_allow_policy.mail_events_dlq.queue_url == aws_sqs_queue.mail_events_dlq.id
    error_message = "The DLQ accepts redrive from the mail-events queue only."
  }
  assert {
    condition     = aws_sqs_queue_policy.mail_events.queue_url == "https://sqs.af-south-1.amazonaws.com/111111111111/pitman-mail-events" && jsondecode(aws_sqs_queue_policy.mail_events.policy).Statement[0].Resource == "arn:aws:sqs:af-south-1:111111111111:pitman-mail-events"
    error_message = "The SNS send policy is on the mail-events queue."
  }
  assert {
    condition     = aws_sns_topic_subscription.mail_events.topic_arn == "arn:aws:sns:af-south-1:111111111111:pitman-ses-events" && aws_sns_topic_subscription.mail_events.endpoint == "arn:aws:sqs:af-south-1:111111111111:pitman-mail-events" && aws_sns_topic_subscription.mail_events.raw_message_delivery
    error_message = "The mail-events queue subscribes to the SES-events topic, raw."
  }
  assert {
    condition     = aws_sesv2_configuration_set_event_destination.suppression.event_destination[0].sns_destination[0].topic_arn == "arn:aws:sns:af-south-1:111111111111:pitman-ses-events" && aws_sns_topic_policy.ses_events.arn == "arn:aws:sns:af-south-1:111111111111:pitman-ses-events"
    error_message = "SES publishes to the SES-events topic, and its policy is on that topic."
  }
  assert {
    condition = sort(jsondecode(aws_iam_role_policy.lambda_mail_events.policy).Statement[0].Action) == sort([
      "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes",
    ])
    error_message = "Receive, delete and get-attributes only."
  }
  assert {
    condition     = jsondecode(aws_sqs_queue_policy.mail_events.policy).Statement[0].Condition.ArnEquals["aws:SourceArn"] == "arn:aws:sns:af-south-1:111111111111:pitman-ses-events"
    error_message = "Only the ses-events topic (not the alert topic) may send to the queue."
  }
  assert {
    condition     = jsondecode(aws_sqs_queue_policy.mail_events.policy).Statement[0].Principal.Service == "sns.amazonaws.com" && jsondecode(aws_sqs_queue_policy.mail_events.policy).Statement[0].Action == "sqs:SendMessage"
    error_message = "The queue policy grants SNS SendMessage and nothing else."
  }
  assert {
    condition = (
      length(jsondecode(aws_sqs_queue_policy.mail_events.policy).Statement) == 2 &&
      jsondecode(aws_sqs_queue_policy.mail_events.policy).Statement[1] == {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "sqs:*"
        Resource  = "arn:aws:sqs:af-south-1:111111111111:pitman-mail-events"
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      }
    )
    error_message = "The bounce queue refuses every request not over TLS, like the sign-in mail queue."
  }
  assert {
    condition     = jsondecode(aws_sns_topic_policy.ses_events.policy).Statement[0].Condition.ArnEquals["aws:SourceArn"] == aws_sesv2_configuration_set.main.arn
    error_message = "Only this configuration set may publish to the topic."
  }
  assert {
    condition     = aws_sqs_queue.mail_events.sqs_managed_sse_enabled && aws_sqs_queue.mail_events_dlq.sqs_managed_sse_enabled
    error_message = "Both queues are SSE-SQS encrypted."
  }
  assert {
    condition     = jsondecode(aws_sqs_queue.mail_events.redrive_policy).maxReceiveCount == 5
    error_message = "The queue dead-letters after 5 receives."
  }
  assert {
    condition     = aws_lambda_event_source_mapping.mail_events.function_name == aws_lambda_function.backend.arn
    error_message = "The queue triggers the existing API Lambda."
  }
  assert {
    condition     = aws_lambda_event_source_mapping.mail_events.batch_size == 10 && aws_lambda_event_source_mapping.mail_events.scaling_config[0].maximum_concurrency == 2
    error_message = "Batches of 10, at most 2 at once."
  }
  assert {
    condition     = aws_lambda_event_source_mapping.mail_events.function_response_types == toset(["ReportBatchItemFailures"])
    error_message = "Only failed records are retried."
  }
  assert {
    condition     = aws_sqs_queue.mail_events.visibility_timeout_seconds == 6 * var.lambda_timeout_seconds + aws_lambda_event_source_mapping.mail_events.maximum_batching_window_in_seconds
    error_message = "The visibility timeout is 6 x the Lambda timeout + the batching window (AWS's SQS guidance)."
  }
  assert {
    condition     = aws_sqs_queue.mail_events.visibility_timeout_seconds == 185 && aws_lambda_event_source_mapping.mail_events.maximum_batching_window_in_seconds == 5
    error_message = "At the defaults: 6 x 30 s + a 5 s batching window = 185 s."
  }
}

run "mail_events_visibility_follows_the_lambda_timeout" {
  command = plan
  variables {
    lambda_timeout_seconds = 25
  }

  assert {
    condition     = aws_sqs_queue.mail_events.visibility_timeout_seconds == 155
    error_message = "With a 25 s timeout the visibility timeout is 6 x 25 + 5 = 155 s."
  }
}

run "reserved_concurrency_below_sqs_minimum_refused" {
  command = plan
  variables {
    lambda_reserved_concurrency = 4
  }
  expect_failures = [var.lambda_reserved_concurrency]
}

run "reserved_concurrency_five_accepted" {
  command = plan
  variables {
    lambda_reserved_concurrency   = 5
    breaker_concurrency_threshold = 5
  }

  assert {
    condition     = aws_lambda_function.backend.reserved_concurrent_executions > aws_lambda_event_source_mapping.mail_events.scaling_config[0].maximum_concurrency + aws_lambda_event_source_mapping.mail_send.scaling_config[0].maximum_concurrency
    error_message = "Reserved concurrency 5 is accepted and is above both mappings' combined maximum concurrency, leaving a copy for the API."
  }
}

# --- The sign-in mail queue (issue #30, A-AUTH-14) ----------------------------------

run "mail_send_queue" {
  command = plan

  assert {
    condition     = aws_sqs_queue.mail_send.arn != aws_sqs_queue.mail_send_dlq.arn && aws_sqs_queue.mail_send.arn != aws_sqs_queue.mail_events.arn
    error_message = "Test harness: the mail queue, its DLQ and the bounce queue must have distinct mock ARNs."
  }
  assert {
    condition     = jsondecode(aws_sqs_queue.mail_send.redrive_policy).deadLetterTargetArn == "arn:aws:sqs:af-south-1:111111111111:pitman-mail-send-dlq" && jsondecode(aws_sqs_queue.mail_send.redrive_policy).maxReceiveCount == 3
    error_message = "The mail queue dead-letters into its own DLQ after 3 receives."
  }
  assert {
    condition     = jsondecode(aws_sqs_queue_redrive_allow_policy.mail_send_dlq.redrive_allow_policy).sourceQueueArns == ["arn:aws:sqs:af-south-1:111111111111:pitman-mail-send"] && aws_sqs_queue_redrive_allow_policy.mail_send_dlq.queue_url == aws_sqs_queue.mail_send_dlq.id
    error_message = "The mail DLQ accepts redrive from the mail queue only."
  }
  assert {
    condition     = aws_sqs_queue.mail_send.message_retention_seconds == 600 && aws_sqs_queue.mail_send_dlq.message_retention_seconds == 86400
    error_message = "A queued email lives as long as its code (10 minutes, auth-kit's CODE_TTL_MS); the DLQ keeps it a day."
  }
  assert {
    condition     = aws_sqs_queue.mail_send.visibility_timeout_seconds == 6 * var.lambda_timeout_seconds && aws_sqs_queue.mail_send.visibility_timeout_seconds == 180
    error_message = "The visibility timeout is 6 x the Lambda timeout (no batching window): 180 s at the default."
  }
  assert {
    condition     = aws_sqs_queue.mail_send.visibility_timeout_seconds * jsondecode(aws_sqs_queue.mail_send.redrive_policy).maxReceiveCount < aws_sqs_queue.mail_send.message_retention_seconds
    error_message = "Every retry happens, and a refused email dead-letters, before SQS's retention deletes it."
  }
  assert {
    condition     = aws_sqs_queue.mail_send.sqs_managed_sse_enabled && aws_sqs_queue.mail_send_dlq.sqs_managed_sse_enabled
    error_message = "Both mail queues are SSE-SQS encrypted (the body is sealed by the backend as well)."
  }
  assert {
    condition = (
      aws_sqs_queue_policy.mail_send.queue_url == "https://sqs.af-south-1.amazonaws.com/111111111111/pitman-mail-send" &&
      length(jsondecode(aws_sqs_queue_policy.mail_send.policy).Statement) == 1 &&
      jsondecode(aws_sqs_queue_policy.mail_send.policy).Statement[0].Effect == "Deny" &&
      jsondecode(aws_sqs_queue_policy.mail_send.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false"
    )
    error_message = "The mail queue's policy only refuses requests not over TLS; it allows nobody anything."
  }
  assert {
    condition     = length(jsondecode(aws_iam_role_policy.lambda_mail_send.policy).Statement) == 2
    error_message = "Two statements: enqueue and consume."
  }
  assert {
    condition = alltrue([
      for st in jsondecode(aws_iam_role_policy.lambda_mail_send.policy).Statement : st.Resource == "arn:aws:sqs:af-south-1:111111111111:pitman-mail-send" && st.Effect == "Allow"
    ])
    error_message = "The role's mail-queue grants name the mail queue only (not its DLQ, not the bounce queue)."
  }
  assert {
    condition = sort(flatten([for st in jsondecode(aws_iam_role_policy.lambda_mail_send.policy).Statement : st.Action])) == sort([
      "sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes",
    ])
    error_message = "SendMessage, ReceiveMessage, DeleteMessage and GetQueueAttributes only."
  }
  assert {
    condition     = aws_lambda_event_source_mapping.mail_send.event_source_arn == "arn:aws:sqs:af-south-1:111111111111:pitman-mail-send" && aws_lambda_event_source_mapping.mail_send.function_name == aws_lambda_function.backend.arn
    error_message = "The mail queue (not its DLQ) triggers the existing API Lambda."
  }
  assert {
    condition     = aws_lambda_event_source_mapping.mail_send.batch_size == 10 && aws_lambda_event_source_mapping.mail_send.maximum_batching_window_in_seconds == 0 && aws_lambda_event_source_mapping.mail_send.scaling_config[0].maximum_concurrency == 2
    error_message = "Batches of 10, no batching window, at most 2 at once."
  }
  assert {
    condition     = aws_lambda_event_source_mapping.mail_send.function_response_types == toset(["ReportBatchItemFailures"])
    error_message = "Only refused sends are retried."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["MAIL_QUEUE"] == "sqs" && aws_lambda_function.backend.environment[0].variables["MAIL_QUEUE_URL"] == "https://sqs.af-south-1.amazonaws.com/111111111111/pitman-mail-send"
    error_message = "The Lambda enqueues to, and dispatches on, the mail queue's URL."
  }
}

run "mail_send_visibility_follows_the_lambda_timeout" {
  command = plan
  variables {
    lambda_timeout_seconds = 25
  }

  assert {
    condition     = aws_sqs_queue.mail_send.visibility_timeout_seconds == 150
    error_message = "With a 25 s timeout the visibility timeout is 6 x 25 = 150 s."
  }
}

# --- Lambda environment and keys (A-AUTH-8) ---------------------------------------

run "lambda_auth_environment" {
  command = plan

  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["USER_STORE"] == "dynamodb"
    error_message = "USER_STORE=dynamodb."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["USERS_TABLE"] == "pitman-users"
    error_message = "USERS_TABLE is the table's name."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["MAIL_TRANSPORT"] == "ses"
    error_message = "MAIL_TRANSPORT=ses."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["MAIL_FROM"] == "no-reply@pitman.jaredhoward.com"
    error_message = "MAIL_FROM is no-reply@<domain>, the address the SES grant allows."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["SES_CONFIGURATION_SET"] == "pitman"
    error_message = "SES_CONFIGURATION_SET is the configuration set's name."
  }
  assert {
    condition     = random_password.auth_code_key.length == 48 && !random_password.auth_code_key.special
    error_message = "AUTH_CODE_KEY: 48 characters, no specials."
  }
  assert {
    condition     = random_password.auth_session_key.length == 48 && !random_password.auth_session_key.special
    error_message = "AUTH_SESSION_KEY: 48 characters, no specials."
  }
}

# A structural check: each key comes from its own random_password resource
# (each overridden above with a different known value), so wiring both
# variables to one resource, or swapping them, fails. It can't prove two real
# random values differ; the backend refuses equal keys at start-up
# (auth/config.ts, auth.unconfigured).
run "auth_keys_wired_to_separate_resources" {
  command = plan

  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["AUTH_CODE_KEY"] == "mock-code-key-mock-code-key-mock-code-key-mock-c"
    error_message = "AUTH_CODE_KEY comes from random_password.auth_code_key."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["AUTH_SESSION_KEY"] == "mock-session-key-mock-session-key-mock-session-"
    error_message = "AUTH_SESSION_KEY comes from random_password.auth_session_key (not the code key's resource)."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["CLOUDFRONT_SHARED_SECRET"] == "mock-cloudfront-secret-mock-cloudfront-secret-mo"
    error_message = "The existing environment is kept: CLOUDFRONT_SHARED_SECRET comes from its own resource."
  }
}

# --- edge (A-AUTH-3, A-AUTH-9) ----------------------------------------------------

run "api_behaviour_never_caches_and_forwards_cookies" {
  command = plan

  assert {
    condition     = one([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : b.cache_policy_id if b.path_pattern == "/api/*"]) == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    error_message = "/api/* must use Managed-CachingDisabled: a signed-in answer is never served from cache."
  }
  assert {
    condition     = one([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : b.origin_request_policy_id if b.path_pattern == "/api/*"]) == "b689b0a8-53d0-40ab-baf2-68738e2966ac"
    error_message = "/api/* must use Managed-AllViewerExceptHostHeader, which forwards every cookie (the session) and the Origin header (csrf())."
  }
}

run "waf_auth_rule" {
  command = plan

  assert {
    condition     = one([for r in aws_wafv2_web_acl.frontend.rule : r.statement[0].rate_based_statement[0].limit if r.name == "RateLimitAuthPerIP"]) == 100
    error_message = "The auth rule allows 100 per IP per 5 minutes."
  }
  assert {
    condition = one([
      for r in aws_wafv2_web_acl.frontend.rule :
      r.statement[0].rate_based_statement[0].aggregate_key_type == "IP" && r.statement[0].rate_based_statement[0].evaluation_window_sec == 300
      if r.name == "RateLimitAuthPerIP"
    ])
    error_message = "The auth rule counts per IP over 5 minutes."
  }
  assert {
    condition = one([
      for r in aws_wafv2_web_acl.frontend.rule :
      length(r.action[0].block) == 1 && length(r.action[0].count) == 0 && length(r.action[0].allow) == 0
      if r.name == "RateLimitAuthPerIP"
    ])
    error_message = "The auth rule blocks (not count, not allow)."
  }
  assert {
    condition = one([
      for r in aws_wafv2_web_acl.frontend.rule :
      [for st in r.statement[0].rate_based_statement[0].scope_down_statement[0].and_statement[0].statement : st.byte_match_statement[0].search_string if length(st.byte_match_statement) == 1]
      if r.name == "RateLimitAuthPerIP"
    ]) == ["/api/auth/"]
    error_message = "The auth rule is scoped to /api/auth/."
  }
  assert {
    condition = one([
      for r in aws_wafv2_web_acl.frontend.rule :
      [for st in r.statement[0].rate_based_statement[0].scope_down_statement[0].and_statement[0].statement : "${st.byte_match_statement[0].positional_constraint}:${length(st.byte_match_statement[0].field_to_match[0].uri_path)}" if length(st.byte_match_statement) == 1]
      if r.name == "RateLimitAuthPerIP"
    ]) == ["STARTS_WITH:1"]
    error_message = "The /api/auth/ match is STARTS_WITH on the URI path."
  }
  assert {
    condition = one([
      for r in aws_wafv2_web_acl.frontend.rule :
      [
        for st in r.statement[0].rate_based_statement[0].scope_down_statement[0].and_statement[0].statement :
        "${st.not_statement[0].statement[0].byte_match_statement[0].search_string}|${st.not_statement[0].statement[0].byte_match_statement[0].positional_constraint}|${length(st.not_statement[0].statement[0].byte_match_statement[0].field_to_match[0].uri_path)}"
        if length(st.not_statement) == 1
      ]
      if r.name == "RateLimitAuthPerIP"
    ]) == ["/api/auth/me|EXACTLY|1"]
    error_message = "/api/auth/me (exactly, on the URI path) is excluded from the auth rule: it runs on every page load."
  }
  assert {
    condition = one([
      for r in aws_wafv2_web_acl.frontend.rule :
      [
        for st in r.statement[0].rate_based_statement[0].scope_down_statement[0].and_statement[0].statement :
        [for t in(length(st.byte_match_statement) == 1 ? st.byte_match_statement[0] : st.not_statement[0].statement[0].byte_match_statement[0]).text_transformation : t.type]
      ]
      if r.name == "RateLimitAuthPerIP"
    ]) == [["URL_DECODE", "NORMALIZE_PATH_WIN", "LOWERCASE"], ["URL_DECODE", "NORMALIZE_PATH_WIN", "LOWERCASE"]]
    error_message = "Both halves of the auth rule normalise the same path: decode, fold backslashes and collapse the path (NORMALIZE_PATH_WIN), lower-case."
  }
  assert {
    condition = one([
      for r in aws_wafv2_web_acl.frontend.rule :
      [for t in r.statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].text_transformation : t.type]
      if r.name == "RateLimitApiPerIP"
    ]) == ["URL_DECODE", "NORMALIZE_PATH_WIN", "LOWERCASE"]
    error_message = "The /api/ rule folds backslashes too (the app routes /auth\\code as /auth/code)."
  }
  assert {
    condition = one([
      for r in aws_wafv2_web_acl.frontend.rule :
      r.statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].search_string == "/api/" && r.statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].positional_constraint == "STARTS_WITH"
      if r.name == "RateLimitApiPerIP"
    ])
    error_message = "/api/auth/me still counts under the /api/ rule (STARTS_WITH /api/, no exclusion)."
  }
  assert {
    condition = one([for r in aws_wafv2_web_acl.frontend.rule : r.priority if r.name == "RateLimitAuthPerIP"]) < min([
      for r in aws_wafv2_web_acl.frontend.rule : r.priority if r.name != "RateLimitAuthPerIP"
    ]...)
    error_message = "The auth rule is evaluated before the broader rules."
  }
  assert {
    condition     = one([for r in aws_wafv2_web_acl.frontend.rule : r.visibility_config[0].metric_name if r.name == "RateLimitAuthPerIP"]) == "pitman-RateLimitAuthPerIP" && aws_cloudwatch_metric_alarm.waf_auth_blocked.dimensions["Rule"] == "pitman-RateLimitAuthPerIP"
    error_message = "The auth-block alarm's Rule dimension is the auth rule's metric name."
  }
}

# WAF's metric dimensions are metric names: WebACL is the ACL's
# visibility_config metric_name, not its resource name.
run "waf_alarms_use_metric_names" {
  command = plan

  assert {
    condition     = aws_cloudwatch_metric_alarm.waf_blocked.dimensions["WebACL"] == aws_wafv2_web_acl.frontend.visibility_config[0].metric_name && aws_cloudwatch_metric_alarm.waf_auth_blocked.dimensions["WebACL"] == aws_wafv2_web_acl.frontend.visibility_config[0].metric_name
    error_message = "Both WAF alarms' WebACL dimension is the ACL's metric name."
  }
  assert {
    condition     = aws_wafv2_web_acl.frontend.visibility_config[0].metric_name == "pitman-frontend-acl-metric" && aws_wafv2_web_acl.frontend.name != aws_wafv2_web_acl.frontend.visibility_config[0].metric_name && aws_cloudwatch_metric_alarm.waf_blocked.dimensions["Rule"] == "ALL"
    error_message = "The ACL's metric (pitman-frontend-acl-metric) differs from its name, so an alarm on the name would be caught; the all-rules alarm uses Rule=ALL."
  }
}

# Sampled requests keep headers (the session cookie) and client IPs in
# us-east-1 for ~3 hours and can't be redacted: off everywhere, metrics on.
run "waf_sampled_requests_off" {
  command = plan

  assert {
    condition     = !aws_wafv2_web_acl.frontend.visibility_config[0].sampled_requests_enabled && aws_wafv2_web_acl.frontend.visibility_config[0].cloudwatch_metrics_enabled
    error_message = "The ACL keeps no sampled requests and still publishes metrics."
  }
  assert {
    condition     = length(aws_wafv2_web_acl.frontend.rule) == 3 && alltrue([for r in aws_wafv2_web_acl.frontend.rule : !r.visibility_config[0].sampled_requests_enabled && r.visibility_config[0].cloudwatch_metrics_enabled])
    error_message = "No rule keeps sampled requests; every rule still publishes metrics."
  }
}

run "auth_limit_below_waf_minimum_refused" {
  command = plan
  variables {
    auth_waf_rate_limit_per_ip = 50
  }
  expect_failures = [var.auth_waf_rate_limit_per_ip]
}

run "auth_limit_above_api_limit_refused" {
  command = plan
  variables {
    auth_waf_rate_limit_per_ip = 400
    waf_api_rate_limit_per_ip  = 300
  }
  expect_failures = [aws_wafv2_web_acl.frontend]
}

# --- alarms -------------------------------------------------------------------

run "auth_alarms" {
  command = plan

  assert {
    condition     = aws_cloudwatch_log_metric_filter.auth_locked.log_group_name == aws_cloudwatch_log_group.lambda.name && strcontains(aws_cloudwatch_log_metric_filter.auth_locked.pattern, "auth.locked")
    error_message = "auth.locked is counted from the API Lambda's log group."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.auth_locked.threshold == 1 && aws_cloudwatch_metric_alarm.auth_locked.comparison_operator == "GreaterThanOrEqualToThreshold" && aws_cloudwatch_metric_alarm.auth_locked.period == 300
    error_message = "One auth.locked in 5 minutes alarms."
  }
  assert {
    condition     = aws_cloudwatch_log_metric_filter.mail_send_failed.log_group_name == aws_cloudwatch_log_group.lambda.name && aws_cloudwatch_log_metric_filter.mail_send_failed.pattern == "\"mail.send_failed\""
    error_message = "mail.send_failed (the event routes.ts logs when SES refuses a code) is counted from the API Lambda's log group."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.mail_send_failed.metric_name == aws_cloudwatch_log_metric_filter.mail_send_failed.metric_transformation[0].name && aws_cloudwatch_metric_alarm.mail_send_failed.namespace == "pitman/Auth"
    error_message = "The mail-send alarm watches the filter's metric."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.mail_send_failed.threshold == 1 && aws_cloudwatch_metric_alarm.mail_send_failed.comparison_operator == "GreaterThanOrEqualToThreshold" && aws_cloudwatch_metric_alarm.mail_send_failed.period == 300 && aws_cloudwatch_metric_alarm.mail_send_failed.statistic == "Sum"
    error_message = "One mail.send_failed in 5 minutes alarms."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.mail_send_failed.alarm_actions == toset([aws_sns_topic.alerts.arn])
    error_message = "The mail-send alarm notifies the primary-region alert topic."
  }
  assert {
    condition     = aws_cloudwatch_log_metric_filter.auth_unconfigured.log_group_name == aws_cloudwatch_log_group.lambda.name && aws_cloudwatch_log_metric_filter.auth_unconfigured.pattern == "\"auth.unconfigured\""
    error_message = "auth.unconfigured (runtime.ts) is counted from the API Lambda's log group."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.auth_unconfigured.metric_name == aws_cloudwatch_log_metric_filter.auth_unconfigured.metric_transformation[0].name && aws_cloudwatch_metric_alarm.auth_unconfigured.threshold == 1 && aws_cloudwatch_metric_alarm.auth_unconfigured.comparison_operator == "GreaterThanOrEqualToThreshold" && aws_cloudwatch_metric_alarm.auth_unconfigured.period == 300
    error_message = "One auth.unconfigured in 5 minutes alarms."
  }

  assert {
    condition     = aws_cloudwatch_log_metric_filter.auth_slow_code_request.log_group_name == aws_cloudwatch_log_group.lambda.name && aws_cloudwatch_log_metric_filter.auth_slow_code_request.pattern == "\"auth.slow_code_request\"" && aws_cloudwatch_metric_alarm.auth_slow_code_request.metric_name == aws_cloudwatch_log_metric_filter.auth_slow_code_request.metric_transformation[0].name && aws_cloudwatch_metric_alarm.auth_slow_code_request.threshold == 3 && aws_cloudwatch_metric_alarm.auth_slow_code_request.period == 900 && aws_cloudwatch_metric_alarm.auth_slow_code_request.alarm_actions == toset([aws_sns_topic.alerts.arn])
    error_message = "Three auth.slow_code_request lines in 15 minutes alarm, counted from the API Lambda's log group."
  }

  assert {
    condition     = aws_cloudwatch_log_metric_filter.cloudfront_secret_unset.log_group_name == aws_cloudwatch_log_group.lambda.name && aws_cloudwatch_log_metric_filter.cloudfront_secret_unset.pattern == "\"cloudfront_secret.unset\"" && aws_cloudwatch_metric_alarm.cloudfront_secret_unset.metric_name == aws_cloudwatch_log_metric_filter.cloudfront_secret_unset.metric_transformation[0].name && aws_cloudwatch_metric_alarm.cloudfront_secret_unset.threshold == 1 && aws_cloudwatch_metric_alarm.cloudfront_secret_unset.period == 300 && aws_cloudwatch_metric_alarm.cloudfront_secret_unset.alarm_actions == toset([aws_sns_topic.alerts.arn])
    error_message = "One cloudfront_secret.unset in 5 minutes alarms."
  }

  assert {
    condition     = aws_cloudwatch_log_metric_filter.mail_record_failed.log_group_name == aws_cloudwatch_log_group.lambda.name && aws_cloudwatch_log_metric_filter.mail_record_failed.pattern == "\"mail.record_failed\"" && aws_cloudwatch_metric_alarm.mail_record_failed.metric_name == aws_cloudwatch_log_metric_filter.mail_record_failed.metric_transformation[0].name && aws_cloudwatch_metric_alarm.mail_record_failed.threshold == 3 && aws_cloudwatch_metric_alarm.mail_record_failed.period == 900 && aws_cloudwatch_metric_alarm.mail_record_failed.alarm_actions == toset([aws_sns_topic.alerts.arn])
    error_message = "mail.record_failed alarms at 3 in 900 s, from the API Lambda's log group."
  }

  assert {
    condition     = aws_cloudwatch_log_metric_filter.mail_events_unrecorded.log_group_name == aws_cloudwatch_log_group.lambda.name && aws_cloudwatch_log_metric_filter.mail_events_unrecorded.pattern == "?\"mail.events_unrecorded\" ?\"mail.queue_unsent\"" && aws_cloudwatch_metric_alarm.mail_events_unrecorded.metric_name == aws_cloudwatch_log_metric_filter.mail_events_unrecorded.metric_transformation[0].name && aws_cloudwatch_metric_alarm.mail_events_unrecorded.threshold == 1 && aws_cloudwatch_metric_alarm.mail_events_unrecorded.period == 300 && aws_cloudwatch_metric_alarm.mail_events_unrecorded.alarm_actions == toset([aws_sns_topic.alerts.arn])
    error_message = "mail.events_unrecorded or mail.queue_unsent alarms at 1 in 300 s, from the API Lambda's log group."
  }

  assert {
    condition     = aws_cloudwatch_log_metric_filter.mail_enqueue_failed.log_group_name == aws_cloudwatch_log_group.lambda.name && aws_cloudwatch_log_metric_filter.mail_enqueue_failed.pattern == "\"mail.enqueue_failed\"" && aws_cloudwatch_metric_alarm.mail_enqueue_failed.metric_name == aws_cloudwatch_log_metric_filter.mail_enqueue_failed.metric_transformation[0].name && aws_cloudwatch_metric_alarm.mail_enqueue_failed.threshold == 1 && aws_cloudwatch_metric_alarm.mail_enqueue_failed.period == 300 && aws_cloudwatch_metric_alarm.mail_enqueue_failed.alarm_actions == toset([aws_sns_topic.alerts.arn])
    error_message = "mail.enqueue_failed alarms at 1 in 300 s, from the API Lambda's log group."
  }
  assert {
    condition     = aws_cloudwatch_log_metric_filter.mail_send_dropped.log_group_name == aws_cloudwatch_log_group.lambda.name && aws_cloudwatch_log_metric_filter.mail_send_dropped.pattern == "?\"mail.send_expired\" ?\"mail.queue_unreadable\"" && aws_cloudwatch_metric_alarm.mail_send_dropped.metric_name == aws_cloudwatch_log_metric_filter.mail_send_dropped.metric_transformation[0].name && aws_cloudwatch_metric_alarm.mail_send_dropped.threshold == 1 && aws_cloudwatch_metric_alarm.mail_send_dropped.period == 300 && aws_cloudwatch_metric_alarm.mail_send_dropped.alarm_actions == toset([aws_sns_topic.alerts.arn])
    error_message = "mail.send_expired or mail.queue_unreadable (a sign-in email dropped unsent) alarms at 1 in 300 s."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.mail_send_dlq.dimensions["QueueName"] == "pitman-mail-send-dlq" && aws_cloudwatch_metric_alarm.mail_send_dlq.metric_name == "ApproximateNumberOfMessagesVisible" && aws_cloudwatch_metric_alarm.mail_send_dlq.threshold == 0 && aws_cloudwatch_metric_alarm.mail_send_dlq.alarm_actions == toset([aws_sns_topic.alerts.arn])
    error_message = "Any message in the mail-send DLQ alarms."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.mail_send_age.dimensions["QueueName"] == "pitman-mail-send" && aws_cloudwatch_metric_alarm.mail_send_age.metric_name == "ApproximateAgeOfOldestMessage" && aws_cloudwatch_metric_alarm.mail_send_age.statistic == "Maximum" && aws_cloudwatch_metric_alarm.mail_send_age.threshold == 120 && aws_cloudwatch_metric_alarm.mail_send_age.alarm_actions == toset([aws_sns_topic.alerts.arn])
    error_message = "A sign-in email older than 2 minutes on the mail queue alarms."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.mail_send_age.threshold < aws_sqs_queue.mail_send.message_retention_seconds
    error_message = "The age alarm fires before SQS's retention silently deletes an unread email."
  }

  assert {
    condition     = aws_cloudwatch_log_metric_filter.mail_events_dropped.log_group_name == aws_cloudwatch_log_group.lambda.name && aws_cloudwatch_log_metric_filter.mail_events_dropped.pattern == "?\"mail.event_refused\" ?\"mail.event_ignored\"" && aws_cloudwatch_metric_alarm.mail_events_dropped.metric_name == aws_cloudwatch_log_metric_filter.mail_events_dropped.metric_transformation[0].name && aws_cloudwatch_metric_alarm.mail_events_dropped.threshold == 1 && aws_cloudwatch_metric_alarm.mail_events_dropped.comparison_operator == "GreaterThanOrEqualToThreshold" && aws_cloudwatch_metric_alarm.mail_events_dropped.period == 3600 && aws_cloudwatch_metric_alarm.mail_events_dropped.alarm_actions == toset([aws_sns_topic.alerts.arn])
    error_message = "mail.event_refused or mail.event_ignored (a bounce or complaint dropped unrecorded) alarms at 1 in an hour, from the API Lambda's log group."
  }
  assert {
    condition     = aws_cloudwatch_log_metric_filter.auth_send_capped.log_group_name == aws_cloudwatch_log_group.lambda.name && aws_cloudwatch_log_metric_filter.auth_send_capped.pattern == "\"auth.send_capped\""
    error_message = "auth.send_capped (a listed address reached its daily code-send cap) is counted from the API Lambda's log group."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.auth_send_capped.metric_name == aws_cloudwatch_log_metric_filter.auth_send_capped.metric_transformation[0].name && aws_cloudwatch_metric_alarm.auth_send_capped.threshold == 1 && aws_cloudwatch_metric_alarm.auth_send_capped.comparison_operator == "GreaterThanOrEqualToThreshold" && aws_cloudwatch_metric_alarm.auth_send_capped.period == 900
    error_message = "One auth.send_capped in 15 minutes alarms."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.ses_bounce_rate.metric_name == "Reputation.BounceRate" && aws_cloudwatch_metric_alarm.ses_complaint_rate.metric_name == "Reputation.ComplaintRate"
    error_message = "SES reputation alarms watch the account's bounce and complaint rates."
  }
  assert {
    condition     = toset(keys(aws_cloudwatch_metric_alarm.users_table)) == toset(["throttles", "system-errors"])
    error_message = "The table has throttle and system-error alarms."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.mail_events_dlq.dimensions["QueueName"] == "pitman-mail-events-dlq"
    error_message = "The DLQ alarm watches the mail-events DLQ."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.waf_auth_blocked.namespace == "AWS/WAFV2"
    error_message = "The auth WAF alarm watches WAF's metrics (in us-east-1)."
  }
}
