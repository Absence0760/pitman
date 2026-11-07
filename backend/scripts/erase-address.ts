// `pnpm admin:erase`: steps 2 and 3 of the erasure procedure (docs/security.md § Erasure). auth-kit's
// eraseAddress removes the user if still listed (refused if they are the last admin), deletes the address's
// code and lock, and replaces the address with `erased:<hmac>` in every audit row and in other users'
// "added by". Then the script removes the address from SES's account-level suppression list itself
// (SES v2 DeleteSuppressedDestination, af-south-1, the operator's own profile), with the address it already
// read from stdin, so the address is never typed into a shell command and never lands in shell history.
// Asks for confirmation. The Lambda has no such grant; the operator's IAM is the operator's.
import { normalEmail, type AuthKit } from '@absence0760/auth-kit';
import type { SESv2Client } from '@aws-sdk/client-sesv2';
import { type OperatorIO, operatorSes, prompter, refuseArguments, runIfMain } from './operator.js';

/** Removes an address from SES's suppression list: `removed`, or `not-suppressed` when SES had no entry. */
export type RemoveSuppression = (email: string) => Promise<'removed' | 'not-suppressed'>;

/** What the script can do about SES: remove the suppression, or nothing (DynamoDB Local has no SES), and why. */
export type Suppression = { remove: RemoveSuppression; where: string } | { remove: null; why: string };

/** SES v2 DeleteSuppressedDestination through `client`, NotFoundException meaning it was never suppressed. */
export function sesSuppressionRemover(client: Pick<SESv2Client, 'send'>): RemoveSuppression {
	return async (email) => {
		const { DeleteSuppressedDestinationCommand } = await import('@aws-sdk/client-sesv2');
		try {
			await client.send(new DeleteSuppressedDestinationCommand({ EmailAddress: email }));
			return 'removed';
		} catch (e) {
			if (e instanceof Error && e.name === 'NotFoundException') return 'not-suppressed';
			throw e;
		}
	};
}

/** The real one: SES in af-south-1 (AWS_REGION overrides) with the operator's profile (AWS_PROFILE, default `pitman`). */
export async function sesSuppression(env: Record<string, string | undefined> = process.env): Promise<Suppression> {
	const ses = await operatorSes(env);
	if (!ses.client) return { remove: null, why: `${ses.why}: there is no SES suppression list to clear` };
	return { remove: sesSuppressionRemover(ses.client), where: ses.where };
}

export async function main(
	io: OperatorIO,
	kit: () => Promise<{ kit: AuthKit; where: string }>,
	suppression: () => Promise<Suppression> = () => sesSuppression()
): Promise<number> {
	refuseArguments(io);
	const { kit: auth, where } = await kit();
	io.stdout.write(`Erasing an address from ${where}. This can't be undone.\n`);
	const ask = prompter(io);
	const email = await ask('Email address to erase: ');
	if ((await ask('Type ERASE to confirm: ')) !== 'ERASE') {
		io.stdout.write('Not confirmed; nothing changed.\n');
		return 1;
	}
	let r: Awaited<ReturnType<AuthKit['eraseAddress']>>;
	try {
		r = await auth.eraseAddress(email);
	} catch (e) {
		// auth-kit throws when audit rows keep appearing after its passes (MAX_SCRUB_PASSES). By name only.
		io.stdout.write(`Not finished (${e instanceof Error ? e.name : 'unknown error'}): rows naming the address were still being written. Run \`pnpm admin:erase\` again with the same address; it carries on where this stopped.\n`);
		return 1;
	}
	if (!r.ok) {
		io.stdout.write(`Refused (${r.status}): ${r.error}\n`);
		return 1;
	}
	io.stdout.write(
		`Done: ${r.value.removedUser ? 'the user was removed' : 'the address was not listed'}; ${r.value.rewritten} audit or "added by" entries now hold the erased:<hmac> pseudonym. Audited as "erase".\n`
	);

	// Step 3, with the address read above (auth-kit accepted it, so it normalises).
	const ses = await suppression();
	if (!ses.remove) {
		io.stdout.write(`SES suppression list: skipped, ${ses.why}.\n`);
	} else {
		try {
			const outcome = await ses.remove(normalEmail(email) ?? email);
			io.stdout.write(`SES suppression list (${ses.where}): ${outcome === 'removed' ? 'the address was removed' : 'the address was not on it'}.\n`);
		} catch (e) {
			// The error's name only: SES may put the address in its message.
			io.stdout.write(
				[
					`SES suppression list (${ses.where}): failed (${e instanceof Error ? e.name : 'unknown error'}); the address may still be on it.`,
					'Your profile needs ses:DeleteSuppressedDestination. Fix that and run `pnpm admin:erase` again with the same address: the database part is already done and is safe to repeat.',
					''
				].join('\n')
			);
			return 1;
		}
	}
	io.stdout.write(
		[
			'',
			'Next (docs/security.md § Erasure):',
			'  4. Record the erasure: the date, and that steps 1 to 3 are done (not the address). It is complete 35 days later, when point-in-time recovery no longer holds the deleted items.',
			''
		].join('\n')
	);
	return 0;
}

runIfMain(import.meta.url, main);
