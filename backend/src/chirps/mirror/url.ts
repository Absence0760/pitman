// Copied from IC-WBT (Absence0760/project-water-management, MIT) backend/src/mirror/url.ts at f888e4461
// MIRROR_URL, parsed: `file:///abs/path` (dev, CI, e2e) or
// `s3://bucket[/prefix]` (production). Its own module, with no zarrita, so
// code that only needs where the copy is (feeds/hostSlot.ts, in the fetcher's
// per-feed path) doesn't load the array library to find out.
import { fileURLToPath } from 'node:url';

/** MIRROR_URL is neither file:///… nor s3://bucket[/prefix]. */
export class MirrorUrlError extends Error {
	override readonly name = 'MirrorUrlError';
}

export type MirrorLocation = { kind: 'file'; dir: string } | { kind: 's3'; bucket: string; prefix: string };

/** Where MIRROR_URL points; throws MirrorUrlError for anything else. */
export function parseMirrorUrl(url: string): MirrorLocation {
	if (url.startsWith('file://')) {
		try {
			return { kind: 'file', dir: fileURLToPath(url) };
		} catch {
			throw new MirrorUrlError('MIRROR_URL file://… needs an absolute path (file:///abs/path)');
		}
	}
	const m = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(?:\/(.*))?$/.exec(url);
	if (m) return { kind: 's3', bucket: m[1]!, prefix: (m[2] ?? '').replace(/^\/+|\/+$/g, '') };
	throw new MirrorUrlError('MIRROR_URL must be file:///abs/path or s3://bucket[/prefix]');
}
