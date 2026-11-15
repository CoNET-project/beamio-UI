/**
 * walletCore: the only main-thread holder of the account private key.
 *
 * The worker never receives the key, the PGP armor or the mnemonic. It can only call the finite command set below,
 * through a session bound to one account. Every command:
 *   - needs the wallet unlocked (a locked wallet refuses at once, nothing is queued);
 *   - needs a live session for the current unlocked account (account mismatch and forged sessions are refused);
 *   - accepts only a command name from the whitelist and a payload with exactly the allowed keys and types;
 *   - returns a result only: a signature, a derived subkey, or decrypted plaintext. Never the key itself;
 *   - times out (the result is discarded and the call fails).
 * There is no "sign arbitrary data" command. Signing domains are fixed in this module.
 *
 * Status: implemented commands are deriveSubkeys, deriveProtocolKeys, signProtocolHistory, signGossip and
 * pgpDecrypt. pgpSign is listed in the whitelist and refused as not available.
 *
 * Main-thread operations (not worker commands): PGP blob seal/open under DEK-local, the legacy blob open used only to
 * migrate, and the signature of the registration request. They return a blob, a plaintext or a signature, never a key
 * or a sub-key (ownPgpBlob.ts, pgpBlob.ts).
 */
import { sha256 } from '@noble/hashes/sha256'
import { hkdf } from '@noble/hashes/hkdf'
import { ethers } from 'ethers'
import type { PrivateKey } from 'openpgp'
import { buildRegiestChatRouteMessage, openLegacyPgpBlob, openPgpBlobV2, sealLegacyPgpBlob, sealPgpBlobV2 } from './pgpBlob'
import { checkGossipMessage, type GossipRejectCode } from './gossipSign'

/** OpenPGP is loaded on first use, so modules that never decrypt do not load it. */
const loadOpenPgp = () => import('openpgp')

/** Chain id in the protocol domain (`beamio.chat.history.v1|224422|eoa`, spec ). */
export const PROTOCOL_CHAIN_ID = 224422

export const WALLET_COMMANDS = ['deriveSubkeys', 'deriveProtocolKeys', 'signProtocolHistory', 'signGossip', 'pgpSign', 'pgpDecrypt'] as const
export type WalletCommand = (typeof WALLET_COMMANDS)[number]
/** Commands that exist in this build. The others are refused with command_not_available. */
const IMPLEMENTED: ReadonlySet<string> = new Set(['deriveSubkeys', 'deriveProtocolKeys', 'signProtocolHistory', 'signGossip'])
/** Default per-call timeout (interface: default 5 s; each end re-measures and reports). */
export const WALLET_CALL_TIMEOUT_MS = 5_000

export type WalletErrorCode =
	| 'locked'
	| 'invalid_key'
	| 'session_invalid'
	| 'account_mismatch'
	| 'command_not_allowed'
	| 'command_not_available'
	| 'payload_rejected'
	| 'timeout'
	| 'pgp_not_loaded'
	| 'pgp_failed'
	| 'pgp_not_in_shell'
	| GossipRejectCode

export class WalletError extends Error {
	constructor(readonly code: WalletErrorCode) {
		// The message is the code only: no key material, no payload content.
		super(code)
		this.name = 'WalletError'
	}
}

export interface WalletStatus {
	state: 'locked' | 'unlocked'
	accountKey: string
}

export interface WalletCallRequest {
	command: string
	accountKey: string
	session: string
	payload: Record<string, unknown>
	timeoutMs?: number
}

/** Operation table. Tests inject a different table to exercise the timeout and the error paths. */
export interface WalletOps {
	deriveSubkeys(key: Uint8Array, eoa: string): { kIdHex: string; kIdxHex: string; dekHex: string }
	deriveProtocolKeys(key: Uint8Array, eoa: string): Promise<{ indexEncKeyHex: string; genesisCidHex: string }>
	signProtocolHistory(key: Uint8Array, eoa: string, kind: 'selfAuth' | 'domain'): Promise<string>
	/** EIP-191 over the caller's UTF-8 bytes, no prefix. The shape is checked before this runs. */
	signGossip(key: Uint8Array, message: string): Promise<string>
}

const hex = (bytes: Uint8Array): string => {
	let s = ''
	for (const b of bytes) s += b.toString(16).padStart(2, '0')
	return s
}

/** UTF-8 bytes without TextEncoder (absent in some test environments). */
const utf8 = (s: string): Uint8Array => {
	const bin = unescape(encodeURIComponent(s))
	const out = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
	return out
}

/** Session handles only bind a call to this page's session table. They are not secrets (the page is the trust root). */
let handleCounter = 0
const newHandle = (): string => {
	const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto
	if (c?.getRandomValues) {
		return Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
	}
	handleCounter += 1
	return `h${Date.now().toString(36)}${handleCounter.toString(36)}`
}

/** HKDF-SHA256 with the same parameters as the SDK (`hkdf(ikm, info, length, salt)`). */
const hkdfSha256 = (ikm: Uint8Array, info: string, salt: string | Uint8Array = new Uint8Array(0)): Uint8Array => {
	const saltBytes = typeof salt === 'string' ? utf8(salt) : salt
	return hkdf(sha256, ikm, saltBytes, utf8(info), 32)
}

/** R_db = HKDF(P, "beamio-chat-local-root|salt|v1", "beamio-chat-local-root|v1|eoa|default"). */
export function rootDb(key: Uint8Array, eoa: string): Uint8Array {
	return hkdfSha256(key, `beamio-chat-local-root|v1|${eoa}|default`, 'beamio-chat-local-root|salt|v1')
}

/** Account key of an EOA in this module (the single account slot is "default"). */
export function accountKeyOf(eoa: string): string {
	return `${eoa.toLowerCase()}:default`
}

/** DEK-local for the PGP blob: HKDF(R_db, fixed info). Domain-separated from the chat DB DEK. */
function pgpBlobDek(key: Uint8Array, eoa: string): Uint8Array {
	return hkdfSha256(rootDb(key, eoa), `beamio-pgp-blob-dek|v1|${eoa}|default`, 'beamio-pgp-blob|salt|v1')
}

/** ChatIndexRegistry (CoNET L1). The EIP-712 domain of the index pointer is fixed here (name, version, chain). */
const REGISTRY_CHAIN_ID = 224422
const CHAT_INDEX_REGISTRY = '0x1511Caa71081C84d8a591490D1b83879088EED72'
const POINTER_TYPES = {
	SetPointer: [
		{ name: 'owner', type: 'address' },
		{ name: 'indexHash', type: 'bytes32' },
		{ name: 'ts', type: 'uint64' },
		{ name: 'seq', type: 'uint64' },
		{ name: 'nonce', type: 'uint256' },
	],
}

/**
 * Forms of the account key string that the legacy PGP blob may have been sealed with (read-side only). Canonical first:
 * "0x" + lower-case hex; then the same with upper-case digits, the "0X" prefix, and no prefix.
 */
function legacyPasswordForms(key: Uint8Array): string[] {
	const lower = hex(key)
	const upper = lower.toUpperCase()
	return [...new Set(['0x' + lower, '0x' + upper, '0X' + lower, '0X' + upper, lower, upper])]
}

/** Protocol domain string. Fixed; the worker cannot choose it. */
export function protocolDomain(eoa: string): string {
	return `beamio.chat.history.v1|${PROTOCOL_CHAIN_ID}|${eoa}`
}

const defaultOps: WalletOps = {
	deriveSubkeys(key, eoa) {
		const rDb = rootDb(key, eoa)
		const kId = hkdfSha256(rDb, 'chat-local-id-v1')
		const kIdx = hkdfSha256(rDb, 'chat-local-idx-v1')
		const dek = hkdfSha256(rDb, `beamio-chat-local-db|v1|${eoa}|default`, 'beamio-chat-local-db|salt|v1')
		return { kIdHex: hex(kId), kIdxHex: hex(kIdx), dekHex: hex(dek) }
	},
	async deriveProtocolKeys(key, eoa) {
		// R_proto = keccak256(utf8(S)), S = EIP-191 signature of the protocol domain. Protocol root only.
		const wallet = new ethers.Wallet(`0x${hex(key)}`)
		const s = await wallet.signMessage(protocolDomain(eoa))
		const rProtoBytes = Uint8Array.from(ethers.getBytes(ethers.keccak256(utf8(s))))
		const indexEnc = hkdfSha256(rProtoBytes, 'index-enc')
		const genesis = hkdfSha256(rProtoBytes, 'frag-genesis')
		return { indexEncKeyHex: hex(indexEnc), genesisCidHex: ethers.hexlify(genesis) }
	},
	async signProtocolHistory(key, eoa, kind) {
		const wallet = new ethers.Wallet(`0x${hex(key)}`)
		// Only the two fixed messages used by the history path (history.ts init: selfSign and domain signature).
		return wallet.signMessage(kind === 'selfAuth' ? wallet.address : protocolDomain(eoa))
	},
	async signGossip(key, message) {
		const wallet = new ethers.Wallet(`0x${hex(key)}`)
		return wallet.signMessage(message)
	},
}

const KEY_HEX = /^[0-9a-fA-F]{64}$/

function ensureKeys(payload: Record<string, unknown>, allowed: readonly string[]): void {
	const keys = Object.keys(payload)
	if (keys.length !== allowed.length || keys.some((k) => !allowed.includes(k))) throw new WalletError('payload_rejected')
}

export class WalletCore {
	private key: Uint8Array | null = null
	private eoa = ''
	private sessions = new Map<string, string>()
	/** PGP private key for (decrypt). Held here only; cleared by lock and by any unlock. Never returned. */
	private pgpKey: PrivateKey | null = null

	constructor(private readonly ops: WalletOps = defaultOps) {}

	private accountOf(eoa: string): string {
		return `${eoa.toLowerCase()}:default`
	}

	/** Unlock with the account private key (32-byte hex). A copy is kept; the caller's string is not retained here. */
	unlock(privateKeyHex: string, eoa: string): boolean {
		const hexKey = (privateKeyHex ?? '').trim().replace(/^0x/i, '')
		if (!KEY_HEX.test(hexKey) || !eoa) return false
		this.lockKeyOnly()
		this.key = Uint8Array.from(ethers.getBytes(`0x${hexKey}`))
		this.eoa = eoa.toLowerCase()
		return true
	}

	/**
	 * PGP blob seal / open under DEK-local (main thread only; not a worker command). The sub-key never leaves this class:
	 * the methods return the blob or the plaintext only. Refused when locked or for another account.
	 */
	async pgpBlobSeal(accountKey: string, plaintext: string): Promise<string> {
		if (process.env.REACT_APP_SHELL_BUILD === 'true') {
			throw new WalletError('pgp_not_in_shell')
		} else {
			const dek = this.requireAccountDek(accountKey)
			try {
				return await sealPgpBlobV2(plaintext, dek)
			} finally {
				dek.fill(0)
			}
		}
	}

	async pgpBlobOpen(accountKey: string, blob: string): Promise<string> {
		if (process.env.REACT_APP_SHELL_BUILD === 'true') {
			throw new WalletError('pgp_not_in_shell')
		} else {
			const dek = this.requireAccountDek(accountKey)
			try {
				return await openPgpBlobV2(blob, dek)
			} finally {
				dek.fill(0)
			}
		}
	}

	/**
	 * Legacy PGP blob open (key = SHA-256 of the account key string, the form written before). Read only. The stored
	 * blob may have been written with another form of the same key string, so the forms are tried in turn (read-only):
	 * canonical first. Nothing is written, and no form is kept. A blob that no form opens is refused as pgp_failed.
	 */
	async pgpBlobLegacyOpen(accountKey: string, blob: string): Promise<string> {
		if (process.env.REACT_APP_SHELL_BUILD === 'true') {
			throw new WalletError('pgp_not_in_shell')
		} else {
			const key = this.requireAccount(accountKey)
			for (const password of legacyPasswordForms(key)) {
				try {
					return await openLegacyPgpBlob(blob, password)
				} catch {
					/* try the next form */
				}
			}
			throw new WalletError('pgp_failed')
		}
	}

	/** Legacy seal (same layout as before). Used only while the v2 write gate is off; the password is the account key. */
	async pgpBlobLegacySeal(accountKey: string, plaintext: string): Promise<string> {
		if (process.env.REACT_APP_SHELL_BUILD === 'true') {
			throw new WalletError('pgp_not_in_shell')
		} else {
			const key = this.requireAccount(accountKey)
			return sealLegacyPgpBlob(plaintext, `0x${hex(key)}`)
		}
	}

	/**
	 * Signs the registration message for `POST /api/regiestChatRoute` with the account key. The message layout is fixed
	 * here; `fields.wallet` must be this account's address. Returns the signature only.
	 */
	async signRegiestChatRoute(
		accountKey: string,
		fields: {
			wallet: string
			keyID: string
			publicKeyArmored: string
			encrypKeyArmored: string
			routeKeyID: string
			timestamp: number
			nonce: string
		},
	): Promise<string> {
		if (process.env.REACT_APP_SHELL_BUILD === 'true') {
			throw new WalletError('pgp_not_in_shell')
		} else {
			const key = this.requireAccount(accountKey)
			const wallet = new ethers.Wallet(`0x${hex(key)}`)
			if (fields.wallet.toLowerCase() !== wallet.address.toLowerCase()) throw new WalletError('payload_rejected')
			const message = buildRegiestChatRouteMessage({ ...fields, keccak: (x) => ethers.keccak256(ethers.toUtf8Bytes(x)) })
			return wallet.signMessage(message)
		}
	}

	private requireAccount(accountKey: string): Uint8Array {
		if (!this.key) throw new WalletError('locked')
		if (accountKey !== this.accountOf(this.eoa)) throw new WalletError('account_mismatch')
		return this.key
	}

	private requireAccountDek(accountKey: string): Uint8Array {
		if (process.env.REACT_APP_SHELL_BUILD === 'true') throw new WalletError('pgp_not_in_shell') // Boundary: not built into a shell.
		return pgpBlobDek(this.requireAccount(accountKey), this.eoa)
	}

	/** Lock: zero the key, drop every session. Pending calls resolve as refused (they check the state on completion). */
	lock(): void {
		this.lockKeyOnly()
		this.sessions.clear()
		this.eoa = ''
	}

	private lockKeyOnly(): void {
		if (this.key) this.key.fill(0)
		this.key = null
		this.pgpKey = null
	}

	/**
	 * load the account's PGP private key so that pgpDecrypt can use it. The armor is read here and is not
	 * kept. Refused when locked or for another account; only an armored PGP private key is accepted.
	 */
	async loadPgpKey(accountKey: string, armor: string, passphrase = ''): Promise<void> {
		if (process.env.REACT_APP_SHELL_BUILD === 'true') {
			throw new WalletError('pgp_not_in_shell')
		} else {
			this.requireAccount(accountKey)
			// Detector constant: the header is matched, not used as key material (no key material in this file).
			if (typeof armor !== 'string' || !armor.includes('-----BEGIN PGP PRIVATE KEY BLOCK-----')) throw new WalletError('payload_rejected')
			let key: PrivateKey
			try {
				const openpgp = await loadOpenPgp()
				const parsed = await openpgp.readPrivateKey({ armoredKey: armor })
				key = parsed.isDecrypted() ? parsed : await openpgp.decryptKey({ privateKey: parsed, passphrase })
			} catch {
				throw new WalletError('pgp_failed')
			}
			this.pgpKey = key
		}
	}

	/**
	 * pgpDecrypt: decrypts an OpenPGP message with the loaded key. Input must be an OpenPGP message
	 * (armored). Returns the plaintext only. Refused when locked, for another account, when no key is loaded, or when the
	 * message is not for this key.
	 */
	async pgpDecrypt(accountKey: string, armoredMessage: string): Promise<string> {
		if (process.env.REACT_APP_SHELL_BUILD === 'true') {
			throw new WalletError('pgp_not_in_shell')
		} else {
			this.requireAccount(accountKey)
			if (typeof armoredMessage !== 'string' || !armoredMessage.trimStart().startsWith('-----BEGIN PGP MESSAGE-----')) {
				throw new WalletError('payload_rejected')
			}
			const key = this.pgpKey
			if (!key) throw new WalletError('pgp_not_loaded')
			try {
				const openpgp = await loadOpenPgp()
				const message = await openpgp.readMessage({ armoredMessage })
				const { data } = await openpgp.decrypt({ message, decryptionKeys: key })
				return typeof data === 'string' ? data : ''
			} catch {
				throw new WalletError('pgp_failed')
			}
		}
	}

	/**
	 * pointerEip712 (kind pointerEip712): the index pointer signature for ChatIndexRegistry. The domain
	 * name, version, chain and registry, the type and the owner are fixed here; the caller gives only the four values.
	 */
	async signPointerEip712(
		accountKey: string,
		value: { indexHash: string; ts: bigint; seq: bigint; nonce: bigint },
	): Promise<string> {
		const key = this.requireAccount(accountKey)
		if (typeof value.indexHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value.indexHash)) throw new WalletError('payload_rejected')
		const uint = (v: unknown, max: bigint): bigint => {
			if (typeof v !== 'bigint' || v < 0n || v > max) throw new WalletError('payload_rejected')
			return v
		}
		const ts = uint(value.ts, (1n << 64n) - 1n)
		const seq = uint(value.seq, (1n << 64n) - 1n)
		const nonce = uint(value.nonce, (1n << 256n) - 1n)
		const wallet = new ethers.Wallet(`0x${hex(key)}`)
		return wallet.signTypedData(
			{ name: 'ChatIndexRegistry', version: '1', chainId: REGISTRY_CHAIN_ID, verifyingContract: CHAT_INDEX_REGISTRY },
			POINTER_TYPES,
			{ owner: wallet.address, indexHash: value.indexHash, ts, seq, nonce },
		)
	}

	status(): WalletStatus {
		return { state: this.key ? 'unlocked' : 'locked', accountKey: this.key ? this.accountOf(this.eoa) : '' }
	}

	/** Open a session for the current unlocked account. The handle is random and bound to that account. */
	openSession(): string {
		if (!this.key) throw new WalletError('locked')
		const handle = newHandle()
		this.sessions.set(handle, this.accountOf(this.eoa))
		return handle
	}

	closeSession(handle: string): void {
		this.sessions.delete(handle)
	}

	/**
	 * Run one whitelisted command. Refuses at once when locked; checks the session, the account, the command name and
	 * the payload shape before any key use. Resolves with a result only (never the key). Times out after timeoutMs.
	 */
	async call(req: WalletCallRequest): Promise<unknown> {
		if (!this.key) throw new WalletError('locked')
		const sessionAccount = this.sessions.get(req.session)
		if (!sessionAccount) throw new WalletError('session_invalid')
		if (sessionAccount !== this.accountOf(this.eoa) || req.accountKey !== sessionAccount) throw new WalletError('account_mismatch')
		if (!(WALLET_COMMANDS as readonly string[]).includes(req.command)) throw new WalletError('command_not_allowed')
		if (!IMPLEMENTED.has(req.command)) throw new WalletError('command_not_available')
		const work = this.run(req)
		const timeoutMs = req.timeoutMs ?? WALLET_CALL_TIMEOUT_MS
		let timer: ReturnType<typeof setTimeout> | undefined
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new WalletError('timeout')), Math.max(0, timeoutMs))
		})
		try {
			return await Promise.race([work, timeout])
		} finally {
			if (timer !== undefined) clearTimeout(timer)
		}
	}

	private async run(req: WalletCallRequest): Promise<unknown> {
		const key = this.key
		const eoa = this.eoa
		if (!key) throw new WalletError('locked')
		switch (req.command) {
			case 'deriveSubkeys':
				ensureKeys(req.payload, [])
				return this.ops.deriveSubkeys(key, eoa)
			case 'deriveProtocolKeys':
				ensureKeys(req.payload, [])
				return this.ops.deriveProtocolKeys(key, eoa)
			case 'signProtocolHistory': {
				ensureKeys(req.payload, ['kind'])
				const kind = req.payload.kind
				if (kind !== 'selfAuth' && kind !== 'domain') throw new WalletError('payload_rejected')
				return this.ops.signProtocolHistory(key, eoa, kind)
			}
			case 'signGossip': {
				ensureKeys(req.payload, ['kind', 'message'])
				const kind = req.payload.kind
				const message = req.payload.message
				if (typeof kind !== 'string' || typeof message !== 'string') throw new WalletError('payload_rejected')
				const check = checkGossipMessage(kind, message, eoa)
				if (!check.ok) throw new WalletError(check.code)
				return this.ops.signGossip(key, message)
			}
			default:
				throw new WalletError('command_not_available')
		}
	}
}

/** The one wallet core of the page. */
export const walletCore = new WalletCore()
