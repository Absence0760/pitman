// Sign-in's settings, read from the environment (docs/deployment.md § Sign-in, docs/run-locally.md § Sign-in).
// Pure: no store, no mail, no I/O. Anything missing or unsafe is a `problem`, and the app then answers 503
// on every route behind the gate (fail closed, A-AUTH-8): a Lambda with no keys or no table must never
// serve the data, nor fall back to a store each instance would hold on its own.
import { MIN_SECRET_LENGTH } from '@absence0760/auth-kit';

export type UserStoreKind = 'memory' | 'dynamodb';
export type MailTransportKind = 'console' | 'smtp' | 'ses';

export interface AuthConfig {
	store: { kind: 'memory' } | { kind: 'dynamodb'; table: string; endpoint?: string };
	codeKey: string;
	sessionKey: string;
	mail:
		| { kind: 'console'; from: string }
		| { kind: 'smtp'; from: string; host: string; port: number }
		| { kind: 'ses'; from: string; configurationSet: string };
	/**
	 * Local dev over plain http only: a non-Secure `pitman_session` cookie instead of `__Host-pitman_session`,
	 * for browsers that refuse a Secure cookie from http://localhost. Never on Lambda (refused below).
	 */
	devCookie: boolean;
}

export type AuthConfigResult = { ok: true; config: AuthConfig } | { ok: false; problem: string };

type Env = Record<string, string | undefined>;

/** True inside AWS Lambda (the runtime always sets this). */
export const onLambda = (env: Env) => !!env.AWS_LAMBDA_FUNCTION_NAME;

const DEV_FROM = 'Pitman <no-reply@localhost>';

/** The settings, or what is wrong with them. A problem names the variable, never its value. */
export function readAuthConfig(env: Env): AuthConfigResult {
	const lambda = onLambda(env);
	const problem = (text: string): AuthConfigResult => ({ ok: false, problem: text });

	const codeKey = env.AUTH_CODE_KEY ?? '';
	const sessionKey = env.AUTH_SESSION_KEY ?? '';
	if (codeKey.length < MIN_SECRET_LENGTH) return problem(`AUTH_CODE_KEY is missing or shorter than ${MIN_SECRET_LENGTH} characters`);
	if (sessionKey.length < MIN_SECRET_LENGTH) return problem(`AUTH_SESSION_KEY is missing or shorter than ${MIN_SECRET_LENGTH} characters`);
	if (codeKey === sessionKey) return problem('AUTH_CODE_KEY and AUTH_SESSION_KEY must be different');

	const storeKind = env.USER_STORE || (lambda ? '' : 'memory');
	let store: AuthConfig['store'];
	if (storeKind === 'memory') {
		// Each Lambda instance would hold its own user list: refused there.
		if (lambda) return problem('USER_STORE=memory is for local dev; the Lambda needs USER_STORE=dynamodb');
		store = { kind: 'memory' };
	} else if (storeKind === 'dynamodb') {
		const table = env.USERS_TABLE ?? '';
		if (!table) return problem('USERS_TABLE is not set');
		const endpoint = env.DYNAMODB_ENDPOINT || undefined;
		if (endpoint && lambda) return problem('DYNAMODB_ENDPOINT is for DynamoDB Local; the Lambda uses the regional endpoint');
		store = endpoint ? { kind: 'dynamodb', table, endpoint } : { kind: 'dynamodb', table };
	} else {
		return problem(storeKind ? 'USER_STORE must be memory or dynamodb' : 'USER_STORE is not set (the Lambda needs dynamodb)');
	}

	const mailKind = env.MAIL_TRANSPORT || (lambda ? '' : 'console');
	const from = env.MAIL_FROM ?? '';
	let mail: AuthConfig['mail'];
	if (mailKind === 'console') {
		if (lambda) return problem('MAIL_TRANSPORT=console is for local dev; the Lambda needs MAIL_TRANSPORT=ses');
		mail = { kind: 'console', from: from || DEV_FROM };
	} else if (mailKind === 'smtp') {
		if (lambda) return problem('MAIL_TRANSPORT=smtp is for local dev (Mailpit); the Lambda needs MAIL_TRANSPORT=ses');
		const port = Number(env.SMTP_PORT || 1025);
		if (!Number.isInteger(port) || port < 1 || port > 65535) return problem('SMTP_PORT is not a port number');
		mail = { kind: 'smtp', from: from || DEV_FROM, host: env.SMTP_HOST || '127.0.0.1', port };
	} else if (mailKind === 'ses') {
		if (!from) return problem('MAIL_FROM is not set');
		const configurationSet = env.SES_CONFIGURATION_SET ?? '';
		// The configuration set carries TLS-required delivery and the bounce and complaint events (A-AUTH-7).
		if (!configurationSet) return problem('SES_CONFIGURATION_SET is not set');
		mail = { kind: 'ses', from, configurationSet };
	} else {
		return problem(mailKind ? 'MAIL_TRANSPORT must be console, smtp or ses' : 'MAIL_TRANSPORT is not set (the Lambda needs ses)');
	}

	const devCookie = env.AUTH_DEV_COOKIE === 'true';
	if (devCookie && lambda) return problem('AUTH_DEV_COOKIE is for local dev over http; the Lambda always uses the __Host- cookie');

	return { ok: true, config: { store, codeKey, sessionKey, mail, devCookie } };
}
