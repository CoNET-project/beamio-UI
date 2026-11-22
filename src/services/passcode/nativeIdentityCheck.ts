/**
 * Same-mnemonic check after a UI unlock while the native side is already unlocked
 *
 *
 * The page sends only the public `eoa` derived from its unlocked mnemonic. No mnemonic, private key, passcode or derived secret
 * leaves the page. The reply decides what the page does next:
 * match:true → continue (same mnemonic)
 * match:false → the approved account-conflict flow (never treat it as the same session)
 * not_ready → the native side is not unlocked: the normal unlock flow
 * bad_request / anything else (timeout, malformed, unknown) → hold: unknown, fail closed, retry
 */
import { buildPasscodeCommand, type BuildResult } from './passcodeCommands'

export type NativeIdentityCheckAction = 'continue' | 'account_conflict' | 'normal_unlock' | 'hold'

/** The check command. Only `eoa` and the page's reqId; a malformed eoa is refused before anything is sent. */
export function buildNativeIdentityCheck(eoa: string, reqId: number): BuildResult {
	return buildPasscodeCommand('nativeIdentityCheck', { reqId, eoa })
}

/** Maps a shell reply to the page action. Anything not clearly one of the four answers holds (fail closed). */
export function decideNativeIdentityCheck(reply: unknown): NativeIdentityCheckAction {
	if (!reply || typeof reply !== 'object') return 'hold'
	const r = reply as { ok?: unknown; match?: unknown; error?: unknown }
	if (r.ok === true) {
		if (r.match === true) return 'continue'
		if (r.match === false) return 'account_conflict'
		return 'hold'
	}
	if (r.ok === false) {
		// the failures are locked (native locked: the passcodeUnlock path) and bad_request (hold). Anything else holds.
		if (r.error === 'locked') return 'normal_unlock'
		return 'hold'
	}
	return 'hold'
}
