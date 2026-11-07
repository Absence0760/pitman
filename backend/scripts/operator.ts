// What the operator scripts share (bootstrap-admin, recover-admin, clear-lock, erase-address): reading the
// address from stdin (never argv, so it stays out of shell history, A-AUTH-5), and auth-kit bound to the
// production table with the operator's own AWS credentials (AWS_PROFILE, default `pitman`).
//
// The table and the code key are read from the Lambda's environment (GetFunctionConfiguration), so the
// key is never typed, pasted or printed: auth-kit needs it to find an address's code and lock items and
// to make erasure's `erased:<hmac>` pseudonym. With DYNAMODB_ENDPOINT set they come from the environment
// instead, for DynamoDB Local.
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createAuthKit, cryptoRandom, randomSecret, type AuthKit } from '@absence0760/auth-kit';
import { dynamoStore } from '@absence0760/auth-kit/dynamodb';
import { dynamoClient } from '../src/auth/store.js';

export interface OperatorIO {
	stdin: Readable;
	stdout: Writable;
	/** The arguments after the script's name. */
	args: string[];
}

export const processIO = (): OperatorIO => ({ stdin: process.stdin, stdout: process.stdout, args: process.argv.slice(2) });

/** Refuses any argument: an address typed on the command line lands in shell history. */
export function refuseArguments(io: OperatorIO) {
	if (io.args.length > 0) throw new OperatorError('This script takes no arguments. Run it bare and type the address when it asks (so it stays out of your shell history).');
}

export class OperatorError extends Error {}

/** Asks each question in turn and reads one line for it from stdin. */
export function prompter(io: OperatorIO) {
	const lines = createInterface({ input: io.stdin, terminal: false })[Symbol.asyncIterator]();
	return async (question: string): Promise<string> => {
		io.stdout.write(question);
		const next = await lines.next();
		if (next.done) throw new OperatorError('No answer (stdin closed).');
		return String(next.value).trim();
	};
}

type Env = Record<string, string | undefined>;

/** Where the table and code key are, and the profile and region used to read them. */
export async function operatorKit(env: Env = process.env): Promise<{ kit: AuthKit; where: string }> {
	let table: string | undefined;
	let codeKey: string | undefined;
	let where: string;
	if (env.DYNAMODB_ENDPOINT) {
		table = env.USERS_TABLE;
		codeKey = env.AUTH_CODE_KEY;
		where = `DynamoDB Local at ${env.DYNAMODB_ENDPOINT}, table ${table ?? '(unset)'}`;
	} else {
		// The SDK reads AWS_PROFILE itself; pitman's operator profile is the default.
		process.env.AWS_PROFILE ||= 'pitman';
		process.env.AWS_REGION ||= 'af-south-1';
		const functionName = env.LAMBDA_FUNCTION || 'pitman-backend';
		const { LambdaClient, GetFunctionConfigurationCommand } = await import('@aws-sdk/client-lambda');
		const config = await new LambdaClient({}).send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
		const vars = config.Environment?.Variables ?? {};
		table = env.USERS_TABLE || vars.USERS_TABLE;
		codeKey = vars.AUTH_CODE_KEY;
		where = `table ${table ?? '(unset)'} in ${process.env.AWS_REGION} (profile ${process.env.AWS_PROFILE}, keys from ${functionName})`;
	}
	if (!table) throw new OperatorError('USERS_TABLE is not set (nor in the Lambda’s environment).');
	if (!codeKey) throw new OperatorError('AUTH_CODE_KEY is not set (nor in the Lambda’s environment).');
	const kit = createAuthKit({
		store: dynamoStore({ client: dynamoClient(env.DYNAMODB_ENDPOINT || undefined), tableName: table }),
		codeSecret: codeKey,
		// The operator's actions issue no sessions; auth-kit still wants a session key, so a throwaway one.
		sessionKeys: [{ kid: 'operator', secret: randomSecret(cryptoRandom) }],
		issuer: 'pitman'
	});
	return { kit, where };
}

/** Runs `main` when the file is the process's entry, printing an OperatorError's message without a stack. */
export function runIfMain(metaUrl: string, main: (io: OperatorIO, kit: () => Promise<{ kit: AuthKit; where: string }>) => Promise<number>) {
	if (!process.argv[1] || metaUrl !== pathToFileURL(process.argv[1]).href) return;
	main(processIO(), () => operatorKit())
		.then((code) => process.exit(code))
		.catch((e: unknown) => {
			console.error(e instanceof OperatorError ? e.message : e);
			process.exit(1);
		});
}
