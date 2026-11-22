/**
 * The automatic first open, run in the chat worker (plan step (b)). The worker generates the chat PGP key, seals its backup with the
 * page-made CryptoKey (encrypt only, see src/services/pgpBlobSealKey.ts in the page), signs the registration with the host signer and
 * posts it. The page gets only the status and the key ID: no key crosses back.
 *
 * Rules: only a confirmed absent record may generate (firstOpen.ts decision table); a failed read waits; a permanent 4xx is kept on this
 * device; a pending copy is continued, never regenerated; one flow per wallet under the lock (firstOpen.ts runFirstOpen).
 *
 * Known gaps, kept visible (see the receipt): the pending copy is stored in plaintext in the worker's IndexedDB, as the page's pending copy
 * already is; the chain read uses the one configured RPC (the page's second read is not repeated here).
 * Pure except for the injected environment, so the flow is tested with fakes.
 */
import { ethers } from 'ethers'
import {
	chainBackupFromRead,
	chainReadFromLookup,
	classifyRegisterStatus,
	generatePgpKeyPair,
	restoreKindFromRead,
	runFirstOpenLocked,
	withFirstOpenLock,
	type ChainPgpRead,
	type ChatInitStatus,
	type FirstOpenDeps,
	type FirstOpenInputs,
	type PendingKey,
	type RegisterClass,
	type RestoreKind,
} from '../firstOpen.js'
import { chooseFirstOpenMailbox } from '../firstOpenRoute.js'
import type { FirstOpenRequest, FirstOpenResult } from '../protocol.js'

/** The AddressPGP reads the first open needs (view calls; `getEncryptedPrivateKey` reads msg.sender, so it carries the account). */
export const PGP_MANAGER_FIRST_OPEN_ABI = [
	'function searchKey(address) view returns (string userPgpKeyID, string userPublicKeyArmored, string routePgpKeyID, string routePublicKeyArmored, bool routeOnline)',
	'function getEncryptedPrivateKey() view returns (string)',
] as const

export type ChainRecordRead = { lookup: { status: 'ok' | 'no_record' | 'network_error'; publicArmored?: string; routersArmoreds?: string; routePgpKeyID?: string; userPgpKeyID?: string }; blob: 'present' | 'missing' | 'unknown' }

export type FirstOpenEnv = {
	/** AddressPGP record and backup presence for the account (throws or returns unknown on failure). */
	readRecord: (eoa: string) => Promise<ChainRecordRead>
	/** Mailbox check: AddressPGP nodeKeyExists for a route key ID. Throws on RPC error. */
	isRecorded: (routeKeyID: string) => Promise<boolean>
	/** Worker-local key-value store (IndexedDB in the browser). */
	store: { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void>; delete: (key: string) => Promise<void> }
	/** Host signature (EIP-191) with the account. */
	signMessage: (message: string) => Promise<string>
	/** The page's encrypt-only CryptoKey for the backup (structured clone from the page). */
	sealKey: CryptoKey
	/** One POST to the registration endpoint; `ok` is the server's flag, `status` the HTTP status (null: no answer). */
	post: (body: Record<string, unknown>) => Promise<{ status: number | null; ok: boolean }>
	generateKeys: (eoa: string) => Promise<PendingKey>
	now: () => number
	random: () => string
}

const PENDING_KEY = (eoa: string) => `firstOpen.pending.v1:${eoa.toLowerCase()}`
const REFUSED_KEY = (eoa: string) => `firstOpen.refused.v1:${eoa.toLowerCase()}`
const BACKOFF_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000]
/** After an accepted registration: no second send of the same copy for this long (the record may show later). */
const REGISTERED_HOLD_MS = 60_000

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
const toBase64Utf8 = (s: string): string => {
	const bytes = utf8(s)
	let bin = ''
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
	return btoa(bin)
}

/** Legacy backup layout (the same bytes as the page's sealLegacyPgpBlob / sealLegacyWithCryptoKey): base64(IV[12] || ciphertext). */
export async function sealLegacyBackup(plaintext: string, key: CryptoKey): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, utf8(plaintext) as BufferSource))
	const raw = new Uint8Array(12 + ct.length)
	raw.set(iv, 0)
	raw.set(ct, 12)
	let bin = ''
	for (let i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i])
	return btoa(bin)
}

/** The fixed registration message (copy of the page's buildRegiestChatRouteMessage; the server verifies this layout). */
export function buildRegiestChatRouteMessage(p: {
	wallet: string
	keyID: string
	publicKeyArmored: string
	encrypKeyArmored: string
	routeKeyID: string
	timestamp: number
	nonce: string
}): string {
	const t = (v: string) => String(v ?? '').trim()
	const h = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s))
	return [
		'Beamio regiestChatRoute',
		`wallet:${t(p.wallet).toLowerCase()}`,
		`keyID:${t(p.keyID)}`,
		`publicKeyArmoredHash:${h(t(p.publicKeyArmored))}`,
		`encrypKeyArmoredHash:${h(t(p.encrypKeyArmored))}`,
		`routeKeyID:${t(p.routeKeyID)}`,
		`timestamp:${p.timestamp}`,
		`nonce:${t(p.nonce).toLowerCase()}`,
	].join('\n')
}

type PendingCopy = PendingKey
const isPending = (v: unknown): v is PendingCopy => {
	const k = v as Partial<PendingCopy> | null
	return !!k && typeof k.keyID === 'string' && typeof k.privateKey === 'string' && typeof k.publicKey === 'string' && !!k.keyID && !!k.privateKey && !!k.publicKey
}

/**
 * The hold state of a wallet (backoff after a failure, and the hold after an accepted registration) is kept in the worker store, per wallet.
 * A worker instance is short-lived (the page ends it after each answer), so the state cannot live in the module.
 */
type Hold = { failures: number; nextAt: number }
const HOLD_KEY = (eoa: string) => `firstOpen.hold.v1:${eoa.toLowerCase()}`
const isHold = (v: unknown): v is Hold => {
	const h = v as Partial<Hold> | null
	return !!h && typeof h.failures === 'number' && typeof h.nextAt === 'number'
}

async function readInputsFor(eoa: string, env: FirstOpenEnv, localOldIdentity: boolean, pending: PendingKey | null): Promise<FirstOpenInputs> {
	const rec = await env.readRecord(eoa).catch((): ChainRecordRead => ({ lookup: { status: 'network_error' }, blob: 'unknown' }))
	// the record decides the restore judgement; an unreadable record is a read error (wait), never a first identity
	const restore: RestoreKind = rec.lookup.status === 'network_error'
		? restoreKindFromRead({ status: 'error' })
		: rec.lookup.status === 'no_record'
			? restoreKindFromRead({ status: 'empty' })
			: restoreKindFromRead({ status: 'ok', privateBlob: 'ok' })
	const chain: ChainPgpRead = chainReadFromLookup(rec.lookup as never)
	const chainBackup = chainBackupFromRead(rec.blob === 'present' ? 'ok' : rec.blob === 'missing' ? 'missing' : 'error')
	return {
		restore,
		chain,
		chainBackup,
		localOldIdentity,
		localPendingOwn: pending !== null,
	}
}

/**
 * Runs the first open for one wallet and returns the status (and the key ID) for the page. The whole command runs under the wallet's lock
 * (tabs included), and reads and writes the persisted hold, so a new worker instance sees the same hold.
 */
export async function runFirstOpenCommand(request: FirstOpenRequest, env: FirstOpenEnv): Promise<FirstOpenResult> {
	const eoa = ethers.getAddress(request.eoa.trim().toLowerCase())
	const writes: Promise<unknown>[] = []
	let refusedNow = false
	let refusedAtStart = false
	let hold: Hold = { failures: 0, nextAt: 0 }
	const saveHold = () => env.store.set(HOLD_KEY(eoa), hold).catch(() => undefined)

	async function loadPending(): Promise<PendingKey | null> {
		const v = await env.store.get(PENDING_KEY(eoa)).catch(() => undefined)
		return isPending(v) ? v : null
	}

	async function registerOnce(wallet: string, key: PendingKey): Promise<RegisterClass> {
		// the route: the page's known mailbox, else a recorded node; a failed check or no recorded node waits (retry), never a guess
		const pick = await chooseFirstOpenMailbox({ current: request.currentMailbox, nodes: request.nodes, isRecorded: env.isRecorded })
		if (pick.status !== 'ok') return 'retry'
		const fields = {
			wallet,
			keyID: key.keyID.trim(),
			publicKeyArmored: toBase64Utf8(key.publicKey).trim(),
			encrypKeyArmored: await sealLegacyBackup(key.privateKey, env.sealKey),
			routeKeyID: pick.mailbox.routeKeyID.trim(),
			timestamp: env.now(),
			nonce: env.random(),
		}
		const message = buildRegiestChatRouteMessage(fields)
		const signature = await env.signMessage(message)
		const res = await env.post({ ...fields, signature })
		if (res.status !== null && res.status >= 200 && res.status < 300 && res.ok) {
			// /: no second send of this copy inside the hold window (the record may show later); the hold is persisted per wallet
			hold = { failures: 0, nextAt: env.now() + REGISTERED_HOLD_MS }
			await saveHold()
			return 'registered'
		}
		return classifyRegisterStatus(res.status)
	}

	const deps: FirstOpenDeps = {
		readInputs: async () => readInputsFor(eoa, env, request.localOldIdentity, await loadPending()),
		readChain: async () => chainReadFromLookup((await env.readRecord(eoa).catch((): ChainRecordRead => ({ lookup: { status: 'network_error' }, blob: 'unknown' }))).lookup as never),
		loadPending,
		savePending: async (k) => {
			await env.store.set(PENDING_KEY(eoa), k).catch(() => undefined)
			return isPending(await env.store.get(PENDING_KEY(eoa)).catch(() => undefined))
		},
		clearPending: async () => {
			await env.store.delete(PENDING_KEY(eoa)).catch(() => undefined)
			return true
		},
		generateKeys: () => env.generateKeys(eoa),
		register: (key) => registerOnce(eoa, key),
		refusedBefore: () => refusedNow,
		markRefused: () => {
			refusedNow = true
			writes.push(env.store.set(REFUSED_KEY(eoa), `4xx:${request.ruleVersion}`).catch(() => undefined))
		},
		recordFailure: () => {
			const failures = hold.failures + 1
			hold = { failures, nextAt: env.now() + BACKOFF_DELAYS_MS[Math.min(failures - 1, BACKOFF_DELAYS_MS.length - 1)] }
			writes.push(saveHold())
		},
		backoffMs: () => Math.max(0, hold.nextAt - env.now()),
	}

	const locked = await withFirstOpenLock<FirstOpenResult>(
		eoa,
		async () => {
			const refusedRaw = await env.store.get(REFUSED_KEY(eoa)).catch(() => undefined)
			refusedAtStart = refusedRaw === `4xx:${request.ruleVersion}`
			refusedNow = refusedAtStart
			const holdRaw = await env.store.get(HOLD_KEY(eoa)).catch(() => undefined)
			hold = isHold(holdRaw) ? holdRaw : { failures: 0, nextAt: 0 }
			const r = await runFirstOpenLocked(eoa, deps)
			await Promise.all(writes)
			const reason = r.status === 'error' && refusedNow && !refusedAtStart ? 'refused_4xx' : undefined
			return { status: r.status as ChatInitStatus, keyID: r.keyID, ...(reason ? { reason } : {}) }
		},
	)
	if (locked === 'busy') return { status: 'registering' }
	return locked
}

/** The production environment: the RPC reads, the store, the host signer, the fetch. */
export function makeWorkerFirstOpenEnv(opts: {
	conetRpcUrl: string
	chainId: number
	pgpManagerAddress: string
	apiBaseUrl: string
	sealKey: CryptoKey
	store: FirstOpenEnv['store']
	signMessage: (message: string) => Promise<string>
	generateKeys: (eoa: string) => Promise<PendingKey>
}): FirstOpenEnv {
	const net = new ethers.Network('conet', opts.chainId)
	const provider = new ethers.JsonRpcProvider(opts.conetRpcUrl, net, { staticNetwork: net })
	const pgp = new ethers.Contract(opts.pgpManagerAddress, PGP_MANAGER_FIRST_OPEN_ABI as unknown as string[], provider)
	return {
		readRecord: async (eoa) => {
			const info = await pgp.searchKey(eoa)
			const pub = String(info?.userPublicKeyArmored ?? '')
			const route = String(info?.routePublicKeyArmored ?? '')
			let lookup: ChainRecordRead['lookup']
			if (!pub && !route) lookup = { status: 'no_record' }
			else lookup = { status: 'ok', publicArmored: atobUtf8(pub), routersArmoreds: atobUtf8(route), routePgpKeyID: String(info.routePgpKeyID ?? ''), userPgpKeyID: String(info.userPgpKeyID ?? '') }
			const blob = String((await pgp.getEncryptedPrivateKey.staticCall({ from: eoa })) ?? '')
			return { lookup, blob: blob ? 'present' : 'missing' }
		},
		isRecorded: async (routeKeyID) => Boolean(await pgp.nodeKeyExists(ethers.id(routeKeyID))),
		store: opts.store,
		signMessage: opts.signMessage,
		sealKey: opts.sealKey,
		post: async (body) => {
			const controller = new AbortController()
			const timer = setTimeout(() => controller.abort(), 15_000)
			try {
				const res = await fetch(`${opts.apiBaseUrl.replace(/\/$/, '')}/api/regiestChatRoute`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
					signal: controller.signal,
				})
				const json = (await res.json().catch(() => ({}))) as { ok?: boolean }
				return { status: res.status, ok: !!json?.ok }
			} catch {
				return { status: null, ok: false }
			} finally {
				clearTimeout(timer)
			}
		},
		generateKeys: opts.generateKeys,
		now: () => Date.now(),
		random: () => ethers.hexlify(ethers.randomBytes(16)),
	}
}

function atobUtf8(b64: string): string {
	if (!b64) return ''
	const bin = atob(b64)
	const bytes = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
	return new TextDecoder().decode(bytes)
}
