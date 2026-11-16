/**
 * `walletCredential` over the window channel only. The native layer answers with the recovery phrase and,
 * inside the shell, a sealed `blob`. The page keeps the `blob` in its IndexedDB record. The phrase is held in memory
 * for one use and dropped at once: it is never persisted by the page and never put into a DOM input.
 * A `eoa_key` account (no phrase) answers `unavailable`; the page does not ask for a private key.
 */
import { ethers } from 'ethers'
import { nextReqId } from './nativeChatRouteRegister'
import { type ShellRecordAnswer, SHELL_RECORD_REPLY_TIMEOUT_MS, sendWindowOnlyCommand } from './shellRecordTransport'

export const WALLET_CREDENTIAL_COMMAND = 'walletCredential'

export type WalletCredentialAnswer =
	| { kind: 'credential'; eoa: string; mnemonic: string; blob: string | null }
	| { kind: 'refused'; code: string }

const EOA_RE = /^0x[0-9a-f]{40}$/

/** Twelve or twenty-four lower-case English words, single-spaced, with a valid BIP-39 checksum. The value is never logged. */
export function isMnemonicPhrase(value: unknown): value is string {
	if (typeof value !== 'string' || !/^[a-z]+( [a-z]+)*$/.test(value)) return false
	const words = value.split(' ').length
	if (words !== 12 && words !== 24) return false
	try {
		ethers.Mnemonic.fromPhrase(value)
		return true
	} catch {
		return false
	}
}

/** Reads one answer of the command. Anything that is not the documented shape is a refusal with a code, never a guess. */
export function parseWalletCredentialAnswer(payload: unknown): WalletCredentialAnswer {
	const p = (payload ?? {}) as { type?: unknown; ok?: unknown; error?: unknown; result?: unknown }
	if (p.type !== 'ack') return { kind: 'refused', code: 'bad_answer' }
	if (p.ok !== true) return { kind: 'refused', code: typeof p.error === 'string' ? p.error : 'bad_answer' }
	const r = (p.result ?? null) as { eoa?: unknown; credentialKind?: unknown; mnemonic?: unknown; blob?: unknown } | null
	if (!r || typeof r !== 'object') return { kind: 'refused', code: 'bad_answer' }
	if (r.credentialKind !== 'mnemonic') return { kind: 'refused', code: 'unavailable' }
	if (typeof r.eoa !== 'string' || !EOA_RE.test(r.eoa) || !isMnemonicPhrase(r.mnemonic)) return { kind: 'refused', code: 'bad_answer' }
	const blob = typeof r.blob === 'string' && r.blob.length > 0 ? r.blob : null
	return { kind: 'credential', eoa: r.eoa, mnemonic: r.mnemonic, blob }
}

/** A transport outcome that is not a payload becomes a refusal with its code (origin, support, timeout). */
function answerOf(answer: ShellRecordAnswer): WalletCredentialAnswer {
	if (answer.kind === 'payload') return parseWalletCredentialAnswer(answer.payload)
	return { kind: 'refused', code: answer.kind === 'none' ? 'none' : answer.kind }
}

/** Asks the native layer for the credential (the window channel only). */
export async function readWalletCredential(): Promise<WalletCredentialAnswer> {
	const reqId = nextReqId()
	return answerOf(await sendWindowOnlyCommand({ type: WALLET_CREDENTIAL_COMMAND, reqId }, SHELL_RECORD_REPLY_TIMEOUT_MS))
}

/** Asks the native layer to unseal a stored `blob` (mode `unseal`). Used when the page needs the phrase later. */
export async function readWalletCredentialUnseal(blob: string): Promise<WalletCredentialAnswer> {
	const reqId = nextReqId()
	return answerOf(await sendWindowOnlyCommand({ type: WALLET_CREDENTIAL_COMMAND, reqId, mode: 'unseal', blob }, SHELL_RECORD_REPLY_TIMEOUT_MS))
}

/**
 * Runs one use of the phrase. The phrase is passed to `use` and the local reference is dropped when it returns. JavaScript strings
 * cannot be wiped, so this limits the reference's life; it does not guarantee that no copy exists.
 */
export function useMnemonicOnce<T>(credential: Extract<WalletCredentialAnswer, { kind: 'credential' }>, use: (mnemonic: string) => T): T {
	const holder: { phrase: string | null } = { phrase: credential.mnemonic }
	try {
		return use(holder.phrase as string)
	} finally {
		holder.phrase = null
	}
}

export type PageCopyAction = 'none' | 'store_blob' | 'update_required' | 'retry' | 'eoa_mismatch' | 'record_unavailable' | 'native_key_missing'

/**
 * Whether a loaded page record belongs to the native account. The first profile's keyID must be a valid address equal to the
 * native EOA (case-insensitive). Anything else is not a match: the record is not used.
 */
export function pageRecordAccountMatches(record: { profiles?: unknown } | null | undefined, eoa: string): boolean {
	const profiles = record?.profiles
	if (!Array.isArray(profiles)) return false
	const first = profiles[0] as { keyID?: unknown } | undefined
	const keyID = typeof first?.keyID === 'string' ? first.keyID.trim() : ''
	if (!/^0x[0-9a-fA-F]{40}$/.test(keyID)) return false
	return keyID.toLowerCase() === eoa.trim().toLowerCase()
}

/**
 * What the page does when the native wallet is ready and the page holds no wallet record: only an empty page record asks for
 * the credential; a credential for another account, a missing blob, or a refusal other than `not_trusted` is a retry and stores nothing.
 */
export function pageCopyAction(input: { pageRecordPresent: boolean; eoa: string; answer: WalletCredentialAnswer }): PageCopyAction {
	if (input.pageRecordPresent) return 'none'
	if (input.answer.kind === 'refused') return input.answer.code === 'not_trusted' ? 'update_required' : 'retry'
	if (input.answer.eoa !== input.eoa.toLowerCase()) return 'retry'
	return input.answer.blob ? 'store_blob' : 'retry'
}
