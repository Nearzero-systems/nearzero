/** Tiled SVG matching login grid feel for transactional email backgrounds. */
export function loginGridEmailBackgroundDataUri(): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><defs><pattern id="nz" width="24" height="24" patternUnits="userSpaceOnUse"><rect width="24" height="24" fill="#ffffff"/><path d="M24 0V24H0" fill="none" stroke="#eceef3" stroke-width="1"/></pattern></defs><rect width="100%" height="100%" fill="url(#nz)"/></svg>`;
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
