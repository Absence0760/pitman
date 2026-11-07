// `pnpm admin:recover`: break-glass (A-AUTH-5). Makes a listed address an admin again and clears its code
// and lock, audited as "recover". The way back in when every admin has lost their mailbox, or one is
// locked out; the AWS account is the root of trust. Reads the address from stdin.
import type { AuthKit } from '@absence0760/auth-kit';
import { type OperatorIO, prompter, refuseArguments, runIfMain } from './operator.js';

export async function main(io: OperatorIO, kit: () => Promise<{ kit: AuthKit; where: string }>): Promise<number> {
	refuseArguments(io);
	const { kit: auth, where } = await kit();
	io.stdout.write(`Recovering an admin in ${where}.\n`);
	const email = await prompter(io)('Listed email address to make an admin: ');
	const r = await auth.recoverAdmin(email);
	if (!r.ok) {
		io.stdout.write(`Refused (${r.status}): ${r.error}\n`);
		return 1;
	}
	io.stdout.write(`Done: user ${r.value.id} is an admin and can ask for a code now; audited as "recover".\n`);
	return 0;
}

runIfMain(import.meta.url, main);
