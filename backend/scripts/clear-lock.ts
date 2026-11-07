// `pnpm admin:clear-lock`: clears an address's sign-in lock, live code and send limits without changing
// its role (auth-kit's clearLock, audited as "clear-lock"). For a user locked out by someone failing codes
// against their address; recover-admin does the same but also makes them an admin. Reads the address from stdin.
import type { AuthKit } from '@absence0760/auth-kit';
import { type OperatorIO, prompter, refuseArguments, runIfMain } from './operator.js';

export async function main(io: OperatorIO, kit: () => Promise<{ kit: AuthKit; where: string }>): Promise<number> {
	refuseArguments(io);
	const { kit: auth, where } = await kit();
	io.stdout.write(`Clearing a sign-in lock in ${where}.\n`);
	const email = await prompter(io)('Email address to unlock: ');
	const r = await auth.clearLock(email);
	if (!r.ok) {
		io.stdout.write(`Refused (${r.status}): ${r.error}\n`);
		return 1;
	}
	io.stdout.write(
		r.value.listed
			? 'Done: the lock, code and send limits are cleared; they can ask for a code now. Audited as "clear-lock".\n'
			: 'Done, but that address is not on the user list (cleared anyway, audited without the address).\n'
	);
	return 0;
}

runIfMain(import.meta.url, main);
