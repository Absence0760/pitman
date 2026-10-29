/**
 * Size limits on what the app will load, so a huge folder or a zip bomb
 * fails with a message instead of exhausting the tab's memory. A real
 * WR2012 network folder is a few MB (docs/formats.md §3); these leave wide
 * room. Round 8 (8.5) reviews them.
 */

export interface LoadLimits {
	/** Most files in one load. */
	readonly maxFiles: number;
	/** Largest single file, bytes (uncompressed). */
	readonly maxFileBytes: number;
	/** Largest total, bytes (uncompressed). */
	readonly maxTotalBytes: number;
}

export const DEFAULT_LIMITS: LoadLimits = {
	maxFiles: 20_000,
	maxFileBytes: 64 * 1024 * 1024,
	maxTotalBytes: 256 * 1024 * 1024
};

/** A load refused for its size, or an unreadable zip: a message for the user. */
export class LoadError extends Error {
	override readonly name = 'LoadError';
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Counts files and bytes against the limits, throwing `LoadError` when one is passed. */
export class LimitTracker {
	private files = 0;
	private bytes = 0;

	constructor(private readonly limits: LoadLimits) {}

	add(path: string, size: number): void {
		this.files++;
		this.bytes += size;
		if (this.files > this.limits.maxFiles) throw new LoadError(`more than ${this.limits.maxFiles} files; load only the network folder`);
		if (size > this.limits.maxFileBytes) throw new LoadError(`${path} is larger than ${mb(this.limits.maxFileBytes)}`);
		if (this.bytes > this.limits.maxTotalBytes) throw new LoadError(`the files add up to more than ${mb(this.limits.maxTotalBytes)}`);
	}
}
