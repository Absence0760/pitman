#!/usr/bin/env bash
# Reset the spend circuit breaker (infra/breaker.tf, R4-I7) after a trip,
# once the cause is found (docs/security.md § Incident playbook):
#
#   pnpm infra:breaker-reset [profile]        (default profile: pitman)
#
#   1. Puts every pitman-breaker-api-* alarm back to OK. A trip fires only on
#      a transition INTO ALARM, so an alarm left in ALARM can't trip again:
#      after this, the next evaluation goes back to ALARM, and trips the
#      breaker again, if the flood is still on. A plain `terraform apply`
#      re-opens the API but leaves the alarms in ALARM, so use this instead.
#   2. Refuses while the current clock hour's Duration is already over the
#      duration trip's threshold (the hourly alarm would re-trip at once on
#      the load that tripped it); BREAKER_RESET_NOW=1 overrides.
#   3. Restores the API's reserved concurrency to Terraform's value
#      (lambda_reserved_concurrency in infra/terraform.tfvars, else 10).
#   4. Redrives the bounce queue's DLQ (pitman-mail-events-dlq) into its
#      source queue: bounces and complaints that dead-lettered while the API
#      was held at 0. The sign-in mail DLQ is not redriven: its codes have
#      expired, and the worker would drop them anyway.
#
# Region: `terraform -chdir=infra output -raw aws_region`, else af-south-1;
# BREAKER_RESET_REGION overrides, and BREAKER_RESET_CONCURRENCY the
# concurrency (tests: infra/scripts/breaker-reset.test.mjs, a fake `aws`). Needs the AWS CLI and the profile's
# credentials; it reads no secret.
set -euo pipefail

profile="${1:-pitman}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
infra="$(dirname "$here")"
function_name="pitman-backend"
alarm_prefix="pitman-breaker-api-"
duration_alarm="pitman-breaker-api-duration"
dlq_name="pitman-mail-events-dlq"

region="${BREAKER_RESET_REGION:-}"
if [ -z "$region" ]; then
	region="$(AWS_PROFILE="$profile" terraform -chdir="$infra" output -raw aws_region 2>/dev/null || true)"
fi
region="${region:-af-south-1}"

concurrency="${BREAKER_RESET_CONCURRENCY:-}"
if [ -z "$concurrency" ] && [ -f "$infra/terraform.tfvars" ]; then
	concurrency="$(sed -nE 's/^[[:space:]]*lambda_reserved_concurrency[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' "$infra/terraform.tfvars" | head -n 1)"
fi
concurrency="${concurrency:-10}"

aws_() { aws --profile "$profile" --region "$region" "$@"; }

echo "Breaker reset: ${function_name} in ${region} (profile ${profile}), reserved concurrency back to ${concurrency}."
echo "Now: reserved concurrency $(aws_ lambda get-function-concurrency --function-name "$function_name" --query ReservedConcurrentExecutions --output text)."

alarms="$(aws_ cloudwatch describe-alarms --alarm-name-prefix "$alarm_prefix" --query 'MetricAlarms[].AlarmName' --output text)"
if [ -z "$alarms" ] || [ "$alarms" = "None" ]; then
	echo "No ${alarm_prefix}* alarms found in ${region}: wrong region or profile?" >&2
	exit 1
fi

# The duration trip sums a clock hour. If this hour is already over it, an OK
# now goes straight back to ALARM and trips again on the load that tripped it.
threshold="$(aws_ cloudwatch describe-alarms --alarm-names "$duration_alarm" --query 'MetricAlarms[0].Threshold' --output text)"
hour_start="$(date -u +%Y-%m-%dT%H:00:00Z)"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
used="$(aws_ cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name Duration \
	--dimensions "Name=FunctionName,Value=${function_name}" --statistics Sum --period 3600 \
	--start-time "$hour_start" --end-time "$now" --query 'Datapoints[0].Sum' --output text)"
if [ "$used" != "None" ] && [ -n "$used" ] && [ "${BREAKER_RESET_NOW:-0}" != "1" ] &&
	awk -v u="$used" -v t="$threshold" 'BEGIN { exit !(u + 0 > t + 0) }'; then
	echo "This clock hour's Duration (${used} ms) is already over the duration trip (${threshold} ms): resetting now would trip it again at once." >&2
	echo "Wait for the next hour (UTC), or run with BREAKER_RESET_NOW=1 to reset anyway." >&2
	exit 2
fi

for alarm in $alarms; do
	aws_ cloudwatch set-alarm-state --alarm-name "$alarm" --state-value OK \
		--state-reason "Breaker reset by the operator (infra/scripts/breaker-reset.sh)"
	echo "Alarm ${alarm}: OK (it trips again if the flood is still on)."
done

aws_ lambda put-function-concurrency --function-name "$function_name" \
	--reserved-concurrent-executions "$concurrency" >/dev/null
echo "Reserved concurrency: ${concurrency}. The API answers again."

dlq_url="$(aws_ sqs get-queue-url --queue-name "$dlq_name" --query QueueUrl --output text)"
waiting="$(aws_ sqs get-queue-attributes --queue-url "$dlq_url" --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text)"
if [ "${waiting:-0}" -gt 0 ]; then
	dlq_arn="$(aws_ sqs get-queue-attributes --queue-url "$dlq_url" --attribute-names QueueArn --query Attributes.QueueArn --output text)"
	aws_ sqs start-message-move-task --source-arn "$dlq_arn" >/dev/null
	echo "Redriving ${waiting} bounce/complaint message(s) from ${dlq_name} to their source queue."
else
	echo "${dlq_name} is empty: nothing to redrive."
fi
