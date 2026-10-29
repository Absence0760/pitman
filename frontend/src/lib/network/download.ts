/** Hand the browser a file to save (DOM only; nothing is uploaded). */
export function downloadBytes(fileName: string, bytes: Uint8Array, type = 'application/zip'): void {
	const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
	const a = document.createElement('a');
	a.href = url;
	a.download = fileName;
	document.body.append(a);
	a.click();
	a.remove();
	// Revoke after the click has been handled.
	setTimeout(() => URL.revokeObjectURL(url), 0);
}
