/**
 * (per the owner's wording): a browser whose database did not open, whose read failed, or whose record is damaged, or
 * whose read timed out, is undetermined. It shows the existing storage-unavailable screen with retry. It never goes to onboarding, so a
 * wallet is never created over an unread one. (Safari private mode, where IndexedDB is unavailable, cannot create an account; the
 * release notes say to use a normal window.)
 *
 * The only route besides the unavailable screen is the shell's native retry (a native store that is not ready yet).
 */
export type StorageUnavailableRoute = 'native_retry' | 'unavailable'

export const storageUnavailableRoute = (input: { nativeShell: boolean; reason: string }): StorageUnavailableRoute =>
	input.nativeShell && input.reason === 'native_retry' ? 'native_retry' : 'unavailable'

/** The reasons a browser read can report. Every one of them is undetermined, never onboarding. */
export const BROWSER_UNAVAILABLE_REASONS: readonly string[] = [
	'indexeddb',
	'read_error',
	'timeout',
	'undetermined',
	'invalid_document',
	'vault_unreadable',
]
