# Credential-free tests of the spend and alerting guardrails (the pre-launch
# infra review, 2026-11-07): the CloudFront traffic alarms (the one spend
# path nothing caps), the budget (gross cost, its lines, the explicit opt-out
# for 0), alert_email refusing empty and example addresses, the user table's
# throughput ceiling, the Lambda's JSON logging, and DATA_REGION following
# icwbt_region rather than aws_region.
#   terraform -chdir=infra init -backend=false && terraform -chdir=infra test
#
# Mocked providers, `command = plan`, no AWS account, no state.

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
  mock_resource "aws_cloudwatch_log_group" {
    override_during = plan
    defaults = {
      arn = "arn:aws:logs:af-south-1:111111111111:log-group:/aws/lambda/pitman-backend"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
}

mock_provider "random" {}
mock_provider "archive" {}

# The two alert topics get distinct ARNs, so an alarm wired to the wrong
# region's topic fails.
override_resource {
  target          = aws_sns_topic.alerts
  override_during = plan
  values = {
    arn = "arn:aws:sns:af-south-1:111111111111:pitman-prod-alerts"
  }
}

override_resource {
  target          = aws_sns_topic.alerts_us_east_1
  override_during = plan
  values = {
    arn = "arn:aws:sns:us-east-1:111111111111:pitman-prod-alerts"
  }
}

override_resource {
  target          = aws_cloudfront_distribution.frontend
  override_during = plan
  values = {
    id = "EDFDVBD6EXAMPLE"
  }
}

variables {
  alert_email = "alerts@pitman.jaredhoward.com"
}

# --- CloudFront traffic alarms ------------------------------------------------

run "cloudfront_traffic_alarms" {
  command = plan

  assert {
    condition = alltrue([
      for a in [aws_cloudwatch_metric_alarm.cloudfront_requests, aws_cloudwatch_metric_alarm.cloudfront_bytes] :
      a.namespace == "AWS/CloudFront" && a.statistic == "Sum" && a.period == 3600 && a.evaluation_periods == 1 &&
      a.comparison_operator == "GreaterThanThreshold" && a.treat_missing_data == "notBreaching" &&
      a.dimensions["DistributionId"] == "EDFDVBD6EXAMPLE" && a.dimensions["Region"] == "Global" &&
      a.alarm_actions == toset(["arn:aws:sns:us-east-1:111111111111:pitman-prod-alerts"])
    ])
    error_message = "Both traffic alarms sum an hour of this distribution's Global metric and notify the us-east-1 topic."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.cloudfront_requests.metric_name == "Requests" && aws_cloudwatch_metric_alarm.cloudfront_requests.threshold == 50000
    error_message = "The requests alarm watches Requests, default 50 000 an hour."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.cloudfront_bytes.metric_name == "BytesDownloaded" && aws_cloudwatch_metric_alarm.cloudfront_bytes.threshold == 5 * 1073741824
    error_message = "The bytes alarm watches BytesDownloaded, default 5 GB an hour, in bytes."
  }
}

run "cloudfront_alarm_thresholds_follow_variables" {
  command = plan

  variables {
    cloudfront_requests_alarm_per_hour = 1234
    cloudfront_gb_alarm_per_hour       = 2
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.cloudfront_requests.threshold == 1234 && aws_cloudwatch_metric_alarm.cloudfront_bytes.threshold == 2147483648
    error_message = "The thresholds come from the variables (GB converted to bytes)."
  }
}

run "cloudfront_requests_threshold_zero_refused" {
  command = plan
  variables {
    cloudfront_requests_alarm_per_hour = 0
  }
  expect_failures = [var.cloudfront_requests_alarm_per_hour]
}

run "cloudfront_gb_threshold_zero_refused" {
  command = plan
  variables {
    cloudfront_gb_alarm_per_hour = 0
  }
  expect_failures = [var.cloudfront_gb_alarm_per_hour]
}

# --- the budget -----------------------------------------------------------------

run "budget_is_gross_with_80_and_100_lines" {
  command = plan

  assert {
    condition     = length(aws_budgets_budget.monthly) == 1 && aws_budgets_budget.monthly[0].limit_amount == "25"
    error_message = "The default budget is $25."
  }
  assert {
    condition     = !aws_budgets_budget.monthly[0].cost_types[0].include_credit && !aws_budgets_budget.monthly[0].cost_types[0].include_refund
    error_message = "Credits and refunds must not net out of the budget (they would hide a runaway)."
  }
  assert {
    condition = sort([
      for n in aws_budgets_budget.monthly[0].notification : "${n.notification_type}-${n.threshold}"
    ]) == sort(["FORECASTED-100", "ACTUAL-80", "ACTUAL-100"])
    error_message = "Budget lines: forecasted 100 %, actual 80 % (above the fixed baseline) and actual 100 %."
  }
  assert {
    condition = alltrue([
      for n in aws_budgets_budget.monthly[0].notification :
      n.subscriber_email_addresses == toset(["alerts@pitman.jaredhoward.com"]) && n.subscriber_sns_topic_arns == toset(["arn:aws:sns:af-south-1:111111111111:pitman-prod-alerts"])
    ])
    error_message = "Every budget line emails alert_email directly and notifies the primary topic."
  }
}

run "budget_zero_refused_without_opt_out" {
  command = plan
  variables {
    budget_monthly_usd = 0
  }
  expect_failures = [var.budget_monthly_usd]
}

run "budget_negative_refused" {
  command = plan
  variables {
    budget_monthly_usd     = -1
    no_budget_acknowledged = true
  }
  expect_failures = [var.budget_monthly_usd]
}

run "budget_zero_with_opt_out_creates_none" {
  command = plan
  variables {
    budget_monthly_usd     = 0
    no_budget_acknowledged = true
  }

  assert {
    condition     = length(aws_budgets_budget.monthly) == 0
    error_message = "budget_monthly_usd = 0 with the explicit opt-out creates no budget (no billing access yet)."
  }
}

# --- alert_email ------------------------------------------------------------------

run "alert_email_subscribes_both_topics" {
  command = plan

  assert {
    condition     = aws_sns_topic_subscription.alerts_email.endpoint == "alerts@pitman.jaredhoward.com" && aws_sns_topic_subscription.alerts_us_east_1_email.endpoint == "alerts@pitman.jaredhoward.com"
    error_message = "alert_email subscribes to the topics in both regions."
  }
  assert {
    condition     = aws_sns_topic_subscription.alerts_email.topic_arn == "arn:aws:sns:af-south-1:111111111111:pitman-prod-alerts" && aws_sns_topic_subscription.alerts_us_east_1_email.topic_arn == "arn:aws:sns:us-east-1:111111111111:pitman-prod-alerts"
    error_message = "Each subscription is on its own region's topic."
  }
}

run "alert_email_empty_refused" {
  command = plan
  variables {
    alert_email = ""
  }
  expect_failures = [var.alert_email]
}

run "alert_email_example_com_refused" {
  command = plan
  variables {
    alert_email = "you+pitman-aws-alerts@example.com"
  }
  expect_failures = [var.alert_email]
}

run "alert_email_example_subdomain_refused" {
  command = plan
  variables {
    alert_email = "ops@mail.Example.ORG"
  }
  expect_failures = [var.alert_email]
}

run "alert_email_test_tld_refused" {
  command = plan
  variables {
    alert_email = "admin@pitman.test"
  }
  expect_failures = [var.alert_email]
}

run "alert_email_invalid_tld_refused" {
  command = plan
  variables {
    alert_email = "admin@nowhere.invalid"
  }
  expect_failures = [var.alert_email]
}

run "alert_email_not_an_address_refused" {
  command = plan
  variables {
    alert_email = "alerts"
  }
  expect_failures = [var.alert_email]
}

run "alert_email_lookalike_domain_accepted" {
  command = plan
  variables {
    alert_email = "ops@myexample.com"
  }
}

# --- the user table's ceiling --------------------------------------------------

run "users_table_throughput_capped" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.users.on_demand_throughput[0].max_read_request_units == 100 && aws_dynamodb_table.users.on_demand_throughput[0].max_write_request_units == 50
    error_message = "The on-demand user table is capped at 100 read and 50 write request units a second."
  }
}

# --- Lambda logging --------------------------------------------------------------

run "lambda_logs_json_platform_warn_app_info" {
  command = plan

  assert {
    condition     = aws_lambda_function.backend.logging_config[0].log_format == "JSON" && aws_lambda_function.backend.logging_config[0].system_log_level == "WARN"
    error_message = "JSON logs with system logs at WARN (drops START/END/REPORT)."
  }
  assert {
    condition     = aws_lambda_function.backend.logging_config[0].application_log_level == "INFO"
    error_message = "Application logs stay at INFO: the backend's console.log lines feed the log-line alarms."
  }
  assert {
    condition     = aws_lambda_function.backend.logging_config[0].log_group == "/aws/lambda/pitman-backend"
    error_message = "Logs go to the log group Terraform owns (retention, metric filters)."
  }
}

# --- DATA_REGION ------------------------------------------------------------------

run "data_region_defaults_to_af_south_1" {
  command = plan

  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["DATA_REGION"] == "af-south-1"
    error_message = "DATA_REGION defaults to IC-WBT's region, af-south-1."
  }
}

run "data_region_independent_of_pitman_region" {
  command = plan
  variables {
    aws_region                = "eu-west-1"
    data_outside_south_africa = true
  }

  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["DATA_REGION"] == "af-south-1"
    error_message = "Moving Pitman's region must not move DATA_REGION: IC-WBT's buckets stay in icwbt_region."
  }
}

run "data_region_follows_icwbt_region" {
  command = plan
  variables {
    icwbt_region = "eu-west-1"
  }

  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["DATA_REGION"] == "eu-west-1"
    error_message = "DATA_REGION is icwbt_region."
  }
}

run "icwbt_region_not_a_region_refused" {
  command = plan
  variables {
    icwbt_region = "cape town"
  }
  expect_failures = [var.icwbt_region]
}
