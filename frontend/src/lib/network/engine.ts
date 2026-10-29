/**
 * The engine's whole-folder API (`packages/wrsm/src/io/bundle.ts`).
 *
 * `@pitman/wrsm`'s `index.ts` belongs to the orchestrator and doesn't export
 * bundle.ts yet, so this shim imports it by path. At integration, once
 * `index.ts` has `export * from './io/bundle.js'`, this becomes
 * `export … from '@pitman/wrsm'` and nothing else changes.
 */

export {
	SIDECAR_FILE,
	bundleKey,
	moduleKey,
	readBundle,
	sameData,
	writeBundle,
	type BundleFileIndex,
	type BundleFiles,
	type BundleIssue,
	type LoadedBundle,
	type ReadBundleOptions,
	type ReadBundleResult,
	type WriteBundleOptions
} from '../../../../packages/wrsm/src/io/bundle.js';
