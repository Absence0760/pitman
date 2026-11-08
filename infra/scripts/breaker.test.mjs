// node --test infra/scripts/*.test.mjs
// The spend circuit breaker (infra/functions/breaker/index.mjs) with a fake
// PutFunctionConcurrency: no SDK, no AWS.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alarmsIn, createBreaker, shouldTrip } from '../functions/breaker/index.mjs';

const sns = (...messages) => ({ Records: messages.map((m) => ({ Sns: { Message: typeof m === 'string' ? m : JSON.stringify(m) } })) });
const alarm = (name, state = 'ALARM') => ({ AlarmName: name, NewStateValue: state, OldStateValue: 'OK' });

function fake() {
	const calls = [];
	const lines = [];
	const breaker = createBreaker({
		putConcurrency: async (name, n) => calls.push([name, n]),
		log: (line) => lines.push(JSON.parse(line)),
		env: { API_FUNCTION_NAME: 'pitman-backend' }
	});
	return { breaker, calls, lines };
}

test('an ALARM sets the API function to 0 reserved concurrency and logs one line', async () => {
	const { breaker, calls, lines } = fake();
	assert.deepEqual(await breaker(sns(alarm('pitman-breaker-api-concurrency'))), { tripped: true });
	assert.deepEqual(calls, [['pitman-backend', 0]]);
	assert.equal(lines.length, 1);
	assert.deepEqual(lines[0], {
		event: 'breaker.tripped',
		function: 'pitman-backend',
		reservedConcurrency: 0,
		alarms: [{ alarm: 'pitman-breaker-api-concurrency', state: 'ALARM' }]
	});
});

test('an OK or INSUFFICIENT_DATA notification does nothing', async () => {
	const { breaker, calls, lines } = fake();
	assert.deepEqual(await breaker(sns(alarm('a', 'OK'), alarm('b', 'INSUFFICIENT_DATA'))), { tripped: false });
	assert.deepEqual(calls, []);
	assert.equal(lines[0].event, 'breaker.ignored');
});

test('fails towards stopping: an unreadable message, an empty event or one ALARM among OKs trips', async () => {
	for (const event of [sns('not json'), sns({ Unexpected: true }), {}, undefined, sns(alarm('a', 'OK'), alarm('b'))]) {
		const { breaker, calls } = fake();
		assert.deepEqual(await breaker(event), { tripped: true });
		assert.deepEqual(calls, [['pitman-backend', 0]]);
	}
});

test('refuses to run without the function name, rather than guess', async () => {
	const breaker = createBreaker({ putConcurrency: async () => assert.fail('must not call'), log: () => {}, env: {} });
	await assert.rejects(breaker(sns(alarm('a'))), /API_FUNCTION_NAME/);
});

test('a failed PutFunctionConcurrency propagates (Lambda retries; the breaker-errors alarm mails)', async () => {
	const breaker = createBreaker({
		putConcurrency: async () => {
			throw new Error('AccessDenied');
		},
		log: () => {},
		env: { API_FUNCTION_NAME: 'pitman-backend' }
	});
	await assert.rejects(breaker(sns(alarm('a'))), /AccessDenied/);
});

test('alarmsIn and shouldTrip', () => {
	assert.deepEqual(alarmsIn(sns(alarm('x'))), [{ alarm: 'x', state: 'ALARM' }]);
	assert.deepEqual(alarmsIn(sns('{')), [{ alarm: null, state: null }]);
	assert.equal(shouldTrip([]), true);
	assert.equal(shouldTrip([{ alarm: 'x', state: 'OK' }]), false);
	assert.equal(shouldTrip([{ alarm: null, state: null }]), true);
});
