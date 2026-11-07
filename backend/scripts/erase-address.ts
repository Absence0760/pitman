// `pnpm admin:erase`: step 2 of the erasure procedure (docs/security.md § Erasure). auth-kit's eraseAddress
// removes the user if still listed (refused if they are the last admin), deletes the address's code and
// lock, and replaces the address with `erased:<hmac>` in every audit row and in other users' "added by".
// Then the operator removes the address from SES's suppression list (the command printed below, typed by
// hand) and records the erasure. Reads the address from stdin, and asks for confirmation.
import type { AuthKit } from '@absence0760/auth-kit';
import { type OperatorIO, prompter, refuseArguments, runIfMain } from './operator.js';

/** Step 3, for the operator to run with the address typed in place of ADDRESS (not echoed here). */
export const SES_STEP = 'aws sesv2 delete-suppressed-destination --email-address ADDRESS --profile pitman --region af-south-1';

export async function main(io: OperatorIO, kit: () => Promise<{ kit: AuthKit; where: string }>): Promise<number> {
	refuseArguments(io);
	const { kit: auth, where } = await kit();
	io.stdout.write(`Erasing an address from ${where}. This can't be undone.\n`);
	const ask = prompter(io);
	const email = await ask('Email address to erase: ');
	if ((await ask('Type ERASE to confirm: ')) !== 'ERASE') {
		io.stdout.write('Not confirmed; nothing changed.\n');
		return 1;
	}
	const r = await auth.eraseAddress(email);
	if (!r.ok) {
		io.stdout.write(`Refused (${r.status}): ${r.error}\n`);
		return 1;
	}
	io.stdout.write(
		[
			`Done: ${r.value.removedUser ? 'the user was removed' : 'the address was not listed'}; ${r.value.rewritten} audit or "added by" entries now hold the erased:<hmac> pseudonym. Audited as "erase".`,
			'',
			'Next (docs/security.md § Erasure):',
			'  3. Remove the address from SES’s suppression list, typing it in place of ADDRESS (NotFoundException means it was never suppressed):',
			`     ${SES_STEP}`,
			'  4. Record the erasure: the date, and that steps 1 to 3 are done. It is complete 35 days later, when point-in-time recovery no longer holds the deleted items.',
			''
		].join('\n')
	);
	return 0;
}

runIfMain(import.meta.url, main);
