// `pnpm dev:auth:seed`: makes the user table in DynamoDB Local (`pnpm dev:auth:up`) with auth-kit's
// tableDefinition, and bootstraps the dev admin (DEV_ADMIN_EMAIL, admin@example.test). Safe to re-run.
// Local only: it refuses any endpoint that isn't on this machine.
import { config } from 'dotenv';
import { CreateTableCommand, ResourceInUseException } from '@aws-sdk/client-dynamodb';
import { tableDefinition } from '@absence0760/auth-kit/dynamodb';
import { dynamoClient } from '../src/auth/store.js';
import { operatorKit } from './operator.js';

config({ path: ['.env.development.local', '.env.development'], quiet: true });

const endpoint = process.env.DYNAMODB_ENDPOINT || 'http://127.0.0.1:8000';
const table = process.env.USERS_TABLE || 'pitman-users-local';
const admin = process.env.DEV_ADMIN_EMAIL || 'admin@example.test';

if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname)) {
	console.error('dev:auth:seed is for DynamoDB Local only: DYNAMODB_ENDPOINT must be on this machine.');
	process.exit(1);
}

try {
	await dynamoClient(endpoint).send(new CreateTableCommand(tableDefinition(table)));
	console.log(`Created table ${table} in DynamoDB Local.`);
} catch (e) {
	if (!(e instanceof ResourceInUseException)) throw e;
	console.log(`Table ${table} already exists.`);
}

const { kit } = await operatorKit({ ...process.env, DYNAMODB_ENDPOINT: endpoint, USERS_TABLE: table });
const r = await kit.bootstrapAdmin(admin);
console.log(r.ok ? 'Seeded the dev admin (DEV_ADMIN_EMAIL).' : r.status === 409 ? 'The table already has an admin; nothing to seed.' : `Dev admin not seeded: ${r.error}`);
