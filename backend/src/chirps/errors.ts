// Copied from IC-WBT (Absence0760/project-water-management, MIT) backend/src/feeds/errors.ts at f888e4461,
// stripped to the two error classes the copied CHIRPS reader throws (docs/data.md § Code to copy).
//
//   FeedFormatError      — the copy answered, but not in the format we read (a changed layout, a
//                          corrupt manifest, a point outside the region). Asking again won't help.
//   FeedUnavailableError — the copy didn't answer usefully (S3 down, a timeout). Asking again may.
//
// The API turns the first into a 422 (or a 503 when it's the copy, not the request, that is wrong)
// and the second into a 503, each with the error's own message (written by us, never an upstream body).

export class FeedFormatError extends Error {
	override readonly name: string = 'FeedFormatError';
}

export class FeedUnavailableError extends Error {
	override readonly name: string = 'FeedUnavailableError';
}
