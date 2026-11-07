/**
 * The responsible party under POPIA (#28 P6; docs/decisions.md, answers to
 * #28's open questions): the operator, as an individual. The privacy notice
 * reads its name and contact address from here and nowhere else.
 *
 * `email` stays null until the address is set up; the notice then says so
 * instead of showing a contact line. `contact.test.ts` refuses a release build
 * (`CI_RELEASE=1`, set by the deploy workflow) while it is still null.
 */

export const PRIVACY_CONTACT = { name: 'Jared Howard', email: null as string | null };
