import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A folder listing that resolves names the way Windows does: WRSM2000
 * networks name `zero.RAN` for a file stored as `ZERO.RAN`
 * (docs/formats.md, "Case").
 */
export class Folder {
	private constructor(
		readonly path: string,
		/** Upper-cased name → name on disk, files only. */
		private readonly files: ReadonlyMap<string, string>,
		/** Upper-cased name → name on disk, directories only. */
		private readonly dirs: ReadonlyMap<string, string>
	) {}

	/** List `path`. Throws when it is not a readable directory. */
	static async open(path: string): Promise<Folder> {
		const files = new Map<string, string>();
		const dirs = new Map<string, string>();
		for (const entry of await readdir(path, { withFileTypes: true })) {
			// Follow symlinks; a broken one counts as a file and fails when read.
			const isDir = entry.isSymbolicLink()
				? await stat(join(path, entry.name)).then((s) => s.isDirectory(), () => false)
				: entry.isDirectory();
			(isDir ? dirs : files).set(entry.name.toUpperCase(), entry.name);
		}
		return new Folder(path, files, dirs);
	}

	/** The on-disk name of file `name`, ignoring case, or undefined. */
	file(name: string): string | undefined {
		return this.files.get(name.toUpperCase());
	}

	/** The on-disk name of subdirectory `name`, ignoring case, or undefined. */
	dir(name: string): string | undefined {
		return this.dirs.get(name.toUpperCase());
	}

	/** On-disk names of the files with extension `ext` (e.g. `.ANS`), ignoring case, sorted. */
	withExtension(ext: string): string[] {
		const upper = ext.toUpperCase();
		return [...this.files.values()].filter((name) => name.toUpperCase().endsWith(upper)).sort();
	}
}
