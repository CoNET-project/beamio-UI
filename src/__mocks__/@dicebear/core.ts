/**
 * Automatic test double for the `@dicebear/core`package (review of 1303e5e7/098f4f7b/ea8a88af: callerAvatar fails after App rendering
 * tests in the same worker, because the real package is ESM and jest does not load it from node_modules). Jest uses this file for every test in
 * `src` (roots), so no test loads the real package. A test may still register its own `jest.mock` with a factory; that wins.
 * The app build does not import this file.
 */
export type Style = unknown

export function createAvatar(_style: unknown, opts?: { seed?: string }) {
	const seed = opts?.seed ?? ''
	return {
		toDataUri: () => `data:image/svg+xml;seed=${seed}`,
		toString: () => `<svg data-seed="${seed}"></svg>`,
	}
}
