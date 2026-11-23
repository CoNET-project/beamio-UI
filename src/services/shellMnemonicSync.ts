/**
 * Page-to-shell mnemonic sync (the rule, 1502: after the home is entered, a trusted native shell receives the current valid
 * mnemonic over the local bridge for durable sync). The home never waits for the reply. A failed send is retried; a reply that arrives
 * after a newer transaction started is discarded (transaction sequence numbers). The mnemonic is never logged.
 *
 * The bridge command is `pwaWalletSync` (spec r2.5.x item 46(4)); its number comes from the shared, persistent sequence (shellTxSeq).
 * No bridge is set in a browser, so a browser build never calls one.
 */

import { markBootSync, type BootSyncEvent } from './bootTrace'
import { nextShellTxSeq } from './shellTxSeq'
import { mnemonicEoa } from './shellLegacyIdbInit'
import { setShellSyncState } from './shellSyncStatus'
import { pwaWalletSyncTransportAvailable, sendPwaWalletSync, sendPwaWalletSyncCipher, type PwaSyncReply } from './pwaWalletSyncTransport'
import { readWalletEoaAddress } from './walletEoaAddress'
import { NO_KEY_ERROR } from './nativeKeyState'

/** The bridge command of the post-home sync (spec r2.5.1, item 46(4)). Replies: ok, stale_seq, write_failed, untrusted_source. */
export const SHELL_MNEMONIC_SYNC_COMMAND = 'pwaWalletSync'

/**
 * r94: the closed reply set of pwaWalletSync (spec r2.5.x item 46(4)), plus `no_answer` for a send that threw or timed out.
 * Only `ok` confirms the write (the native side read its own write back).
 */
/** `locked` (HC-LOCK, v10 §3.2 pwaWalletSync): the native lock. Not retried automatically; not counted as synced. */
export type ShellSyncAnswer = 'ok' | 'stale_seq' | 'write_failed' | 'untrusted_source' | 'key_over_bridge_refused' | 'bad_request' | 'no_answer' | 'locked' | 'unlock_failed' | 'verify_failed'

export type SyncOutcome =
	| { kind: 'synced'; tx: number }
	| { kind: 'superseded'; tx: number }
	| { kind: 'unavailable'; tx: number }
	/** The sync did not finish. `retryable`: a transient code (write_failed, no_answer) that a later retry may fix. */
	| { kind: 'failed'; tx: number; code: ShellSyncCode; retryable: boolean; reason?: string }

export type ShellSyncCode = Exclude<ShellSyncAnswer, 'ok'>

export type ShellMnemonicSyncDeps = {
	/** Sends one transaction over the bridge and returns the reply code. A throw counts as `no_answer`. */
	send: (command: string, txId: number, mnemonic: string, eoa: string) => Promise<ShellSyncAnswer | { code: ShellSyncAnswer; reason?: string }>
	/** Re-reads the native state (nativeMnemonicPreread) after a failed write, before another try (spec §十一, §57(2)). Optional. */
	reread?: (seq: number) => Promise<'valid' | 'absent' | 'unknown'>
	/** Retry delays after each failed send. The number of retries is the length of this list. */
	retryDelaysMs: readonly number[]
	wait: (ms: number) => Promise<void>
	/** Log lines never carry the mnemonic or the EOA. */
	log: (message: string) => void
	/** False when no trusted bridge exists (a browser build): no call is made. */
	bridgeAvailable: () => boolean
	/** Called once a sync is confirmed `ok`, with the EOA the page sent with the confirmed write (r95: the native EOA hint). It never
	 *  changes the sync result: a throw here is ignored. Optional. */
	onSynced?: (eoa: string) => void
	/** QA boot markers (sync=send|reply|retry seq=n). The default does nothing; the app-wide sync reports through bootTrace. */
	trace?: (event: BootSyncEvent, seq: number) => void
	/** The transaction number of a sync: shared and persistent in the app (shellTxSeq); a local counter when not given (tests). */
	nextSeq?: () => number
	/** The cipher request (spec 30.1 / §29 section 6): one transaction; the default is sendPwaWalletSyncCipher. Optional (tests). */
	sendCipher?: (txId: number, cipher: Record<string, unknown>, passcode?: string) => Promise<PwaSyncReply>
}

export type ShellMnemonicSync = {
	sync: (mnemonic: string, eoa: string) => Promise<SyncOutcome>
	/** The v3 cipher sync (spec 30.1 and 2.3): synced only on the shell's read-back confirmation (stored, readback match). The cipher is sent exactly as stored. */
	syncCipher: (cipher: Record<string, unknown>, eoa: string, passcode?: string) => Promise<SyncOutcome>
}

/**
 * r92 step 6 (P2, draft 24.2): the page sends its mnemonic to the shell only when the page's own evidence is valid: the phrase derives to
 * the EOA it reports (BIP-39, m/44'/60'/0'/0/0). Unknown, a confirmed empty store, or a phrase that does not derive gives nothing.
 */
export function pageSyncPayload(evidence: { kind: string; phrase?: string; eoa?: string; nativeValidated?: boolean }): { phrase: string; eoa: string } | null {
	if (evidence.kind !== 'valid') return null
	const phrase = typeof evidence.phrase === 'string' ? evidence.phrase.trim() : ''
	const eoa = typeof evidence.eoa === 'string' ? evidence.eoa.toLowerCase() : ''
	if (!phrase || !eoa) return null
	// r94: a native-validated copy carries the native EOA; the page does not derive it again
	if (evidence.nativeValidated === true) return { phrase, eoa }
	return mnemonicEoa(phrase) === eoa ? { phrase, eoa } : null
}

export function createShellMnemonicSync(deps: ShellMnemonicSyncDeps): ShellMnemonicSync {
	let latest = 0
	// r94 (PHRASE_ONLY, E5.1): a failed write is not retried by itself; the next attempt (a user retry) re-reads first
	let writeFailedPending = false
	let localCount = 0
	const nextSeq = deps.nextSeq ?? (() => ++localCount)
	const trace = deps.trace ?? (() => undefined)
	return {
		async sync(mnemonic: string, eoa: string): Promise<SyncOutcome> {
			// one number for the whole sync: a retry is sent with the same number (the shell accepts it again)
			const tx = nextSeq()
			latest = tx
			// r92 step 6 (P2): an empty phrase or an EOA that is not an address is never sent (no empty write reaches the store)
			if (!mnemonic.trim() || !/^0x[0-9a-fA-F]{40}$/.test(eoa)) return { kind: 'unavailable', tx }
			if (!deps.bridgeAvailable()) return { kind: 'unavailable', tx }
			// a user retry after a failed write: the native state is read again first; unknown holds, nothing is sent
			if (writeFailedPending && deps.reread) {
				const state = await deps.reread(tx)
				if (state === 'unknown') {
					deps.log(`[shellMnemonicSync] transaction ${tx}: the native state is unknown after the failed write; held, nothing sent`)
					setShellSyncState({ kind: 'failed', code: 'write_failed', retryable: true, reason: 'internal_state' })
					return { kind: 'failed', tx, code: 'write_failed', retryable: true, reason: 'internal_state' }
				}
			}
			setShellSyncState({ kind: 'syncing' })
			let code: ShellSyncCode = 'no_answer'
			let retryable = true
			let reason: string | undefined
			for (let attempt = 0; attempt <= deps.retryDelaysMs.length; attempt++) {
				if (attempt > 0) {
					await deps.wait(deps.retryDelaysMs[attempt - 1])
					if (tx !== latest) return { kind: 'superseded', tx }
				}
				trace('send', tx)
				let answer: ShellSyncAnswer
				reason = undefined
				try {
					const reply = await deps.send(SHELL_MNEMONIC_SYNC_COMMAND, tx, mnemonic, eoa)
					answer = typeof reply === 'string' ? reply : reply.code
					reason = typeof reply === 'string' ? undefined : reply.reason
				} catch {
					answer = 'no_answer'
				}
				// a reply that arrives after a newer transaction started is discarded: it cannot overwrite the newer sync
				if (tx !== latest) return { kind: 'superseded', tx }
				if (answer === 'ok') {
					trace('reply', tx)
					writeFailedPending = false
					setShellSyncState({ kind: 'synced' })
					try {
						deps.onSynced?.(eoa)
					} catch {
						/* the hint is a side effect; the sync result stands */
					}
					return { kind: 'synced', tx }
				}
				// stale_seq while this is still the latest transaction: the shell's number is ahead of this one. Not confirmed: shown as retryable (a
				// retry takes a new number); nothing is cleared. A newer transaction started first is superseded (above), and it owns the state.
				if (answer === 'stale_seq') {
					code = 'stale_seq'
					retryable = true
					break
				}
				code = answer
				// untrusted_source and bad_request do not change with a retry; write_failed and no_answer may
				retryable = answer === 'write_failed' || answer === 'no_answer'
				if (!retryable) break
				// a failed write is not retried by itself (E5.1: the native side answers write_failed/internal_state for a phrase-only state): the
				// failure is shown with a manual retry, which re-reads first
				if (answer === 'write_failed') {
					writeFailedPending = true
					break
				}
				if (attempt < deps.retryDelaysMs.length) trace('retry', tx)
				deps.log(`[shellMnemonicSync] transaction ${tx} attempt ${attempt + 1} not confirmed (${code}); retry`)
			}
			// the failure is shown on the home; the local data and the home are not changed by it
			deps.log(`[shellMnemonicSync] transaction ${tx} not confirmed (${code}); the home is unchanged`)
			setShellSyncState({ kind: 'failed', code, retryable, reason })
			return { kind: 'failed', tx, code, retryable, reason }
			},
		async syncCipher(cipher: Record<string, unknown>, eoa: string, passcode?: string): Promise<SyncOutcome> {
			const tx = nextSeq()
			latest = tx
			if (!cipher || typeof cipher !== 'object' || !/^0x[0-9a-fA-F]{40}$/.test(eoa)) return { kind: 'unavailable', tx }
			if (!deps.bridgeAvailable()) return { kind: 'unavailable', tx }
			const send = deps.sendCipher ?? ((t: number, c: Record<string, unknown>, p?: string) => sendPwaWalletSyncCipher(SHELL_MNEMONIC_SYNC_COMMAND, t, c, p))
			// a request that carries the passcode is sent once: the passcode is used for this one request only and is never retried or logged
			const delays = passcode === undefined ? deps.retryDelaysMs : []
			setShellSyncState({ kind: 'syncing' })
			let code: ShellSyncCode = 'no_answer'
			let retryable = true
			for (let attempt = 0; attempt <= delays.length; attempt++) {
				if (attempt > 0) {
					await deps.wait(delays[attempt - 1])
					if (tx !== latest) return { kind: 'superseded', tx }
				}
				let reply: PwaSyncReply
				try {
					reply = await send(tx, cipher, passcode)
				} catch {
					reply = { code: 'no_answer' }
				}
				if (tx !== latest) return { kind: 'superseded', tx }
				// completed only on the shell's read-back confirmation (spec 30.1: stored and readback match), mapped by mapCipherSyncReply
				if (reply.code === 'ok') {
					writeFailedPending = false
					setShellSyncState({ kind: 'synced' })
					return { kind: 'synced', tx }
				}
				code = reply.code as ShellSyncCode
				// no_answer is retried on the schedule; write_failed is not retried by itself (30.4); the passcode-branch codes are not retried
				retryable = code === 'no_answer' || code === 'write_failed' || code === 'stale_seq'
				if (code !== 'no_answer') break
				deps.log(`[shellMnemonicSync] cipher transaction ${tx} attempt ${attempt + 1} not confirmed (${code}); retry`)
			}
			deps.log(`[shellMnemonicSync] cipher transaction ${tx} not confirmed (${code}); the page record is unchanged`)
			setShellSyncState({ kind: 'failed', code, retryable })
			return { kind: 'failed', tx, code, retryable }
		},
	}
}

let bridgeSender: ShellMnemonicSyncDeps['send'] | null = null

/** Installed by the trusted shell bridge only. Never set in a browser. */
export function setShellMnemonicSyncBridge(send: ShellMnemonicSyncDeps['send'] | null): void {
	bridgeSender = send
}

const RETRY_DELAYS_MS = [2_000, 10_000, 30_000] as const

/**
 * The native state after a failed write (review a, 2026-11-17). It is read with walletEoaAddress, which carries no secret. It never uses
 * nativeMnemonicPreread: the page may hold a valid phrase here, and that command is only for a page that has no valid mnemonic (E6, with the
 * trusted top-frame gate). An address answer is 'valid' (the native side has an account); no_key is 'absent'; anything else is 'unknown'
 * (held, nothing sent).
 */
export async function rereadNativeAccountState(): Promise<'valid' | 'absent' | 'unknown'> {
	const answer = await readWalletEoaAddress().catch(() => null)
	if (!answer) return 'unknown'
	if (answer.kind === 'address') return 'valid'
	if (answer.kind === 'refused' && answer.code === NO_KEY_ERROR) return 'absent'
	return 'unknown'
}

/** The app-wide sync. It is started after the home is entered and never awaited by the route. */
export const shellMnemonicSync: ShellMnemonicSync = createShellMnemonicSync({
	// r94: the production request goes over the shell transport (window or iOS chat); a test or a shell may install another sender.
	send: (command, txId, mnemonic, eoa) => (bridgeSender ? bridgeSender(command, txId, mnemonic, eoa) : sendPwaWalletSync(command, txId, mnemonic, eoa)),
	reread: () => rereadNativeAccountState(),
	retryDelaysMs: RETRY_DELAYS_MS,
	wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	log: (message) => {
		// no mnemonic or EOA is ever passed here
		console.warn(message)
	},
	bridgeAvailable: () => bridgeSender !== null || pwaWalletSyncTransportAvailable(),
	trace: (event, seq) => markBootSync(event, seq),
	nextSeq: nextShellTxSeq,
	// r95: a confirmed sync records the account EOA as the native EOA hint (the native wallet's public address). The module is loaded
	// lazily so this file does not import the native wallet statically.
	onSynced: (eoa) => {
		void import('./nativeWallet').then((m) => m.rememberNativeEoa(eoa)).catch(() => undefined)
	},
})
