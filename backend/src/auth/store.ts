// The user store auth-kit runs on: its in-memory store (local dev and tests) or its DynamoDB
// single-table store (the Lambda, or DynamoDB Local with DYNAMODB_ENDPOINT). The store's rules are
// auth-kit's; this only picks one and builds its client.
import { memoryStore, type Store } from '@absence0760/auth-kit';
import { dynamoStore } from '@absence0760/auth-kit/dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { AuthConfig } from './config.js';

/** DynamoDB Local accepts any letters-and-digits credentials; these open nothing anywhere else. */
const LOCAL_CREDENTIALS = { accessKeyId: 'dynamodblocal', secretAccessKey: 'dynamodblocal' };

export function dynamoClient(endpoint?: string): DynamoDBClient {
	// The Lambda: its own region and role. DynamoDB Local: the endpoint, a region the SDK needs, and dummy credentials.
	return endpoint ? new DynamoDBClient({ endpoint, region: process.env.AWS_REGION || 'af-south-1', credentials: LOCAL_CREDENTIALS }) : new DynamoDBClient({});
}

export function createUserStore(config: AuthConfig['store']): Store {
	if (config.kind === 'memory') return memoryStore();
	return dynamoStore({ client: dynamoClient(config.endpoint), tableName: config.table });
}
