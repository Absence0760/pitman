// The spend circuit breaker (infra/breaker.tf). Subscribed to the breaker SNS
// topic, which only the breaker alarms publish to: on an ALARM it sets the API
// function's reserved concurrency to 0, so no copy runs and no compute,
// request or cross-account GET is billed until the operator resets it
// (`terraform apply`, or the one-line CLI reset in docs/security.md §
// Incident playbook). The same alarms mail the alert topic, so the operator
// hears of it from them; this function's role holds nothing but
// lambda:PutFunctionConcurrency on the API function and its own log group.
//
// Plain JavaScript, no bundle: the AWS SDK v3 comes from the nodejs24.x
// runtime. It is imported lazily so the test (infra/scripts/breaker.test.mjs)
// runs the logic with a fake and no SDK installed.

/**
 * The alarm names and states in an SNS event. A record whose message is not
 * a CloudWatch alarm notification yields `{ alarm: null, state: null }`.
 */
export function alarmsIn(event) {
	return (event?.Records ?? []).map((r) => {
		try {
			const m = JSON.parse(r?.Sns?.Message ?? '');
			return { alarm: typeof m.AlarmName === 'string' ? m.AlarmName : null, state: typeof m.NewStateValue === 'string' ? m.NewStateValue : null };
		} catch {
			return { alarm: null, state: null };
		}
	});
}

/**
 * Trip unless every record is a readable notification of a state other than
 * ALARM. Fails towards stopping: only the breaker alarms can publish to the
 * topic, so an unreadable message is still theirs.
 */
export function shouldTrip(alarms) {
	if (alarms.length === 0) return true;
	return !alarms.every((a) => a.state !== null && a.state !== 'ALARM');
}

export function createBreaker({ putConcurrency, log = console.log, env = process.env }) {
	return async (event) => {
		const functionName = env.API_FUNCTION_NAME;
		if (!functionName) throw new Error('API_FUNCTION_NAME is not set');
		const alarms = alarmsIn(event);
		if (!shouldTrip(alarms)) {
			log(JSON.stringify({ event: 'breaker.ignored', function: functionName, alarms }));
			return { tripped: false };
		}
		await putConcurrency(functionName, 0);
		log(JSON.stringify({ event: 'breaker.tripped', function: functionName, reservedConcurrency: 0, alarms }));
		return { tripped: true };
	};
}

let client;

export const handler = async (event) => {
	const { LambdaClient, PutFunctionConcurrencyCommand } = await import('@aws-sdk/client-lambda');
	client ??= new LambdaClient({});
	const putConcurrency = (FunctionName, ReservedConcurrentExecutions) =>
		client.send(new PutFunctionConcurrencyCommand({ FunctionName, ReservedConcurrentExecutions }));
	return createBreaker({ putConcurrency })(event);
};
