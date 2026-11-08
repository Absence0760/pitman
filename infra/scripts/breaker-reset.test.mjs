// node --test infra/scripts/*.test.mjs
// The breaker reset (infra/scripts/breaker-reset.sh) against a fake `aws` on
// PATH that records each call and answers from a scenario: no AWS, no
// credentials.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./breaker-reset.sh', import.meta.url));

// The fake CLI: argv minus the global --profile/--region pair is matched
// against the scenario's answers by the first two words (service, command).
const FAKE_AWS = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify(args) + '\\n');
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_AWS_SCENARIO, 'utf8'));
const words = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const key = words.slice(0, 2).join(' ');
let answer = scenario[key];
if (key === 'cloudwatch describe-alarms') answer = args.includes('--alarm-names') ? scenario['threshold'] : scenario['alarms'];
if (key === 'sqs get-queue-attributes') answer = args.includes('QueueArn') ? scenario['dlq arn'] : scenario['dlq depth'];
process.stdout.write(answer === undefined ? '' : String(answer) + '\\n');
`;

function run(scenario, env = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'breaker-reset-'));
	try {
		writeFileSync(join(dir, 'aws'), FAKE_AWS);
		chmodSync(join(dir, 'aws'), 0o755);
		writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
		const log = join(dir, 'calls.log');
		writeFileSync(log, '');
		const r = spawnSync('bash', [SCRIPT, 'test-profile'], {
			encoding: 'utf8',
			env: {
				PATH: `${dir}:${process.env.PATH}`,
				FAKE_AWS_LOG: log,
				FAKE_AWS_SCENARIO: join(dir, 'scenario.json'),
				BREAKER_RESET_REGION: 'af-south-1',
				BREAKER_RESET_CONCURRENCY: '10',
				...env
			}
		});
		const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
		return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const TRIPPED = {
	'lambda get-function-concurrency': '0',
	alarms: 'pitman-breaker-api-concurrency\tpitman-breaker-api-duration\tpitman-breaker-api-invocations',
	threshold: '7200000.0',
	'cloudwatch get-metric-statistics': 'None',
	'sqs get-queue-url': 'https://sqs.af-south-1.amazonaws.com/111111111111/pitman-mail-events-dlq',
	'dlq depth': '3',
	'dlq arn': 'arn:aws:sqs:af-south-1:111111111111:pitman-mail-events-dlq'
};

const named = (calls, service, command) => calls.filter((c) => c.includes(service) && c.includes(command));

test('sets every breaker-api alarm to OK, then restores concurrency, then redrives the bounce DLQ', () => {
	const { status, calls, stderr } = run(TRIPPED);
	assert.equal(status, 0, stderr);
	for (const c of calls) assert.deepEqual(c.slice(0, 4), ['--profile', 'test-profile', '--region', 'af-south-1']);
	const ok = named(calls, 'cloudwatch', 'set-alarm-state');
	assert.deepEqual(
		ok.map((c) => c[c.indexOf('--alarm-name') + 1]),
		['pitman-breaker-api-concurrency', 'pitman-breaker-api-duration', 'pitman-breaker-api-invocations']
	);
	assert.ok(ok.every((c) => c[c.indexOf('--state-value') + 1] === 'OK'));
	const put = named(calls, 'lambda', 'put-function-concurrency');
	assert.equal(put.length, 1);
	assert.equal(put[0][put[0].indexOf('--function-name') + 1], 'pitman-backend');
	assert.equal(put[0][put[0].indexOf('--reserved-concurrent-executions') + 1], '10');
	// Alarms first: re-armed before the API opens again.
	const order = calls.map((c) => c.slice(4, 6).join(' '));
	assert.ok(order.lastIndexOf('cloudwatch set-alarm-state') < order.indexOf('lambda put-function-concurrency'));
	const move = named(calls, 'sqs', 'start-message-move-task');
	assert.equal(move.length, 1);
	assert.equal(move[0][move[0].indexOf('--source-arn') + 1], 'arn:aws:sqs:af-south-1:111111111111:pitman-mail-events-dlq');
	assert.ok(!calls.some((c) => c.join(' ').includes('mail-send-dlq')), 'the sign-in mail DLQ is never redriven');
});

test('an empty DLQ is left alone', () => {
	const { status, calls } = run({ ...TRIPPED, 'dlq depth': '0' });
	assert.equal(status, 0);
	assert.equal(named(calls, 'sqs', 'start-message-move-task').length, 0);
});

test('refuses while this clock hour is already over the duration trip, unless BREAKER_RESET_NOW=1', () => {
	const busy = { ...TRIPPED, 'cloudwatch get-metric-statistics': '9000000.0' };
	const refused = run(busy);
	assert.equal(refused.status, 2);
	assert.match(refused.stderr, /trip it again/);
	assert.equal(named(refused.calls, 'cloudwatch', 'set-alarm-state').length, 0);
	assert.equal(named(refused.calls, 'lambda', 'put-function-concurrency').length, 0);
	const forced = run(busy, { BREAKER_RESET_NOW: '1' });
	assert.equal(forced.status, 0, forced.stderr);
	assert.equal(named(forced.calls, 'lambda', 'put-function-concurrency').length, 1);
});

test('stops before changing anything when no breaker alarms are found (wrong region or profile)', () => {
	const { status, calls, stderr } = run({ ...TRIPPED, alarms: 'None' });
	assert.equal(status, 1);
	assert.match(stderr, /wrong region or profile/);
	assert.equal(named(calls, 'lambda', 'put-function-concurrency').length, 0);
});
