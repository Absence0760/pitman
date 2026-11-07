// `pnpm admin:bootstrap`: makes the first admin, once (A-AUTH-5). auth-kit's bootstrapAdmin is one
// transaction that refuses once any admin has existed, so a second run (or two at once) can't add another.
// Reads the address from stdin; run it with the operator's profile (docs/deployment.md § Sign-in).
import type { AuthKit } from '@absence0760/auth-kit';
import { type OperatorIO, prompter, refuseArguments, runIfMain } from './operator.js';

export async function main(io: OperatorIO, kit: () => Promise<{ kit: AuthKit; where: string }>): Promise<number> {
	refuseArguments(io);
	const { kit: auth, where } = await kit();
	io.stdout.write(`Bootstrapping the first admin in ${where}.\n`);
	const email = await prompter(io)('First admin’s email address: ');
	const r = await auth.bootstrapAdmin(email);
	if (!r.ok) {
		io.stdout.write(`Refused (${r.status}): ${r.error}\n`);
		return 1;
	}
	io.stdout.write(`Done: the first admin is listed (user id ${r.value.id}), audited as "bootstrap". Sign in, then add a second admin.\n`);
	return 0;
}

runIfMain(import.meta.url, main);
