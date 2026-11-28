/**
 * Encrypted fragmented IPFS history — runs inside the Worker.
 *
 * Design (repo plan `beamio_chat_sdk`, on-chain head pointer variant):
 * - master = keccak256(EOA_sign("beamio.chat.history.v1|chainId|eoa")) (private key never leaves worker)
 * - indexKey = HKDF(master, "index-enc") → AES-256-GCM of the ordered index manifest
 * - fragment ratchet: k_i = HKDF(master, `frag|${seq}|${cid_{i-1}}`), cid_{-1}=HKDF(master,"frag-genesis")
 * cipher_i = AES-GCM(k_i, plaintext_i); cid_i = keccak256(cipher_i) → content-addressed IPFS fragment.
 * All cid_{i-1} recorded in the index → any k_i is O(1) derivable (newest-first restore).
 * - HEAD POINTER (mutable): the encrypted index cipher is itself a content-addressed IPFS fragment
 * (indexHash = keccak256(cipher)). The *latest* indexHash is recorded on-chain in `ChatIndexRegistry`
 * via an EIP-712 `SetPointer(owner,indexHash,ts,seq,nonce)` signed offline by the EOA; a gasless API
 * relayer pays gas. Only the owner's signature can move the owner's pointer (write right = private key).
 * Read path is pure RPC `getPointer(eoa)` (no mutable server state). Replaces the old `point-${L}` alias.
 *
 * Trust rule: a failed/untrusted network read must NOT clobber the local IndexedDB
 * mirror (repo `beamio-trusted-vs-untrusted-fetch`).
 */

import { ethers } from 'ethers'
import { type AccountSigning } from '../signer.js'

import type { HistoryEntry, HistoryLoadOptions, HistoryReadOptions, PersistenceAdapter } from '../types.js'
import { LocalChatStore, type SyncRecord } from '../local/store.js'
import { openIdbBackend } from '../local/idb-backend.js'
import { sha256Hex, utf8 } from '../local/codec.js'
import type { ChatKind, ClearResult, IncomingRecord, PageResult, Viewport } from '../local/types.js'
import { deriveSendKey } from '../local/store.js'
import {
	aesGcmDecryptString,
	aesGcmEncryptString,
	base64ToBytes,
	bytesToBase64,
	hexToBytes,
	hkdf,
	keccakUtf8,
} from '../crypto.js'

/** ChatIndexRegistry lives only on CoNET L1; EIP-712 domain chainId is fixed. */
const REGISTRY_CHAIN_ID = 224422
const REGISTRY_READ_ABI = [
	'function getPointer(address) view returns (bytes32 indexHash,uint64 ts,uint64 seq,uint64 updatedAt)',
	'function nonceOf(address) view returns (uint256)',
] as const
const SET_POINTER_TYPES = {
	SetPointer: [
		{ name: 'owner', type: 'address' },
		{ name: 'indexHash', type: 'bytes32' },
		{ name: 'ts', type: 'uint64' },
		{ name: 'seq', type: 'uint64' },
		{ name: 'nonce', type: 'uint256' },
	],
} as const

interface IndexRecord {
	seq: number
	cid: string
	prevCid: string
	ts: number
	peer: string
	dir: 'in' | 'out'
	sendId?: string
	preview?: string
}

interface IndexManifest {
	v: 1
	eoa: string
	updatedAt: number
	records: IndexRecord[]
}

export interface HistoryEmit {
	buffer(peer: string, entries: HistoryEntry[], isTail: boolean): void
	log(level: 'info' | 'warn' | 'error', message: string): void
}

const LOCAL_INDEX_KEY_PREFIX = 'beamio.chat.history.index:'
const LOCAL_FRAG_KEY_PREFIX = 'beamio.chat.history.frag:'
const LOCAL_PLAIN_KEY_PREFIX = 'beamio.chat.history.plain:'
/** this account's library has been the page's source on this device (migration switched / purged): remembered here so a worker session whose library cannot open yet still knows an append must not be confirmed without the library row */
/** the records of this account whose remote commit (fragment upload, index upload, on-chain pointer) has not succeeded yet: a durable list `[{cid, sendId?}]`, so a kill and restart can resume it */
const LOCAL_REMOTE_PENDING_PREFIX = 'beamio.chat.history.remotepending:'
/** how long one remote step may take before it counts as failed (a hanging request must not hold the append chain for ever) */
const REMOTE_STEP_TIMEOUT_MS = 30_000
/** an abort signal that fires after REMOTE_STEP_TIMEOUT_MS (undefined where AbortSignal.timeout does not exist) */
const remoteStepSignal = (ms: number = REMOTE_STEP_TIMEOUT_MS): AbortSignal | undefined => {
	try {
		const t = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout
		return typeof t === 'function' ? t(ms) : undefined
	} catch {
		return undefined
	}
}
export type RemoteCommitStep = 'ok' | 'no_fragment' | 'upload' | 'index_upload' | 'pointer' | 'record_missing' | 'head_unsynced'
/** does this list of index records hold the record of a pending entry (by fragment id, or by sendId after a re-linearisation) */
const holdsPending = (records: ReadonlyArray<{ cid: string; sendId?: string }>, p: { cid: string; sendId?: string }): boolean =>
	records.some((r) => r.cid === p.cid || (!!p.sendId && r.sendId === p.sendId))
/** one document per record that is waiting for a remote commit (added only; removed by name once a published head holds it). The single list above is still read, so nothing written by it is forgotten. */
const LOCAL_PENDING_RECORD_PREFIX = 'beamio.chat.history.pendingrec:'
/** the positive evidence that a record has been in a published head: only this, or the head itself, lets a repeated append be confirmed. "Not in a pending list" proves nothing. */
const LOCAL_PUBLISHED_PREFIX = 'beamio.chat.history.published:'
/** runs `fn` alone among every tab and worker of this origin that uses the same name */
export type HistoryAccountLock = <T>(name: string, fn: () => Promise<T>) => Promise<T>
const browserAccountLock = (): HistoryAccountLock | undefined => {
	const locks = (globalThis as { navigator?: { locks?: { request: (name: string, options: object, cb: () => Promise<unknown>) => Promise<unknown> } } }).navigator?.locks
	return locks ? <T>(name: string, fn: () => Promise<T>) => locks.request(name, { mode: 'exclusive' }, fn) as Promise<T> : undefined
}
const LOCAL_LIBAUTH_KEY_PREFIX = 'beamio.chat.history.libauth:'
const FRAGMENT_GENESIS_INFO = 'frag-genesis'

interface PlainRecord {
	entry: HistoryEntry
	searchText: string
}

function extractSearchText(body: string): string {
	const parts: string[] = []
	const push = (value: unknown) => {
		if (typeof value === 'string' && value.trim()) parts.push(value)
	}
	try {
		const msg = JSON.parse(body) as Record<string, unknown>
		push(msg.text)
		const call = msg.callRecord as Record<string, unknown> | undefined
		push(call?.status)
		const file = msg.fileMessage as Record<string, unknown> | undefined
		push(file?.filename)
		push(file?.archiveName)
		if (msg.voiceMessage) parts.push('voice message')
		const payment = msg.paymentCard as Record<string, unknown> | undefined
		push(payment?.title)
	} catch {
		push(body)
	}
	return parts.join('\n').toLowerCase()
}

function isPlainRecord(value: unknown): value is PlainRecord {
	if (!value || typeof value !== 'object') return false
	const row = value as PlainRecord
	const entry = row.entry
	return (
		!!entry &&
		typeof entry.body === 'string' &&
		typeof entry.peer === 'string' &&
		(entry.dir === 'in' || entry.dir === 'out') &&
		typeof row.searchText === 'string'
	)
}

/**
 * The legacy plaintext history cache (`beamio.chat.history.plain:`) exists for the migration period only. Once the library holds the history (migration `complete`, then `switched`, then `purged`) no plaintext
 * copy is written and none is read. Any other state (none, running, or one this code does not know) keeps the legacy behaviour.
 */
export function plainCacheEnabledFor(state: string | null | undefined): boolean {
	return state !== 'complete' && state !== 'switched' && state !== 'purged'
}

/** The migration states this code knows. A non-null state outside the list keeps the legacy behaviour (cache on) but is reported once (a warn log), so a new state cannot switch the plaintext cache on silently. */
const KNOWN_MIGRATION_STATES: readonly string[] = ['none', 'running', 'complete', 'switched', 'purged']
export const isKnownMigrationState = (state: string | null | undefined): boolean => typeof state === 'string' && KNOWN_MIGRATION_STATES.includes(state)

export type PurgeLegacyPlainResult = {
	/** purged: all plaintext keys of this account are gone; clean: there were none; blocked: something could not be proven in the library, NOTHING was deleted; failed: a step failed after the proof (the keys that are left stay); skipped: not applicable */
	status: 'purged' | 'clean' | 'blocked' | 'failed' | 'skipped'
	reason: string
	/** plaintext keys found, rows that were readable, rows the library did not hold (inserted), rows it already held, unreadable keys (no history in them), keys removed, keys left after the delete */
	keys: number
	rows: number
	inserted: number
	present: number
	junk: number
	removed: number
	remaining: number
}

function diagnosticCid(cid: string): string {
	return typeof cid === 'string' && cid.length > 12
		? `${cid.slice(0, 10)}…${cid.slice(-8)}`
		: cid
}

/** Kind from the stored ChatMessage JSON. Ciphertext-only manifests are reported as `file`. */
function kindOfBody(body: string): ChatKind {
	try {
		const msg = JSON.parse(body) as Record<string, unknown>
		const fm = msg.fileMessage as { mediaKind?: string } | undefined
		if (fm) return fm.mediaKind === 'image' ? 'image' : fm.mediaKind === 'video' ? 'video' : 'file'
		if (msg.callRecord || msg.paymentCard) return 'system'
		if (typeof msg.text === 'string') return 'text'
		return 'unknown'
	} catch {
		return 'unknown'
	}
}

/** Build the library input from a decrypted history entry. Body text is passed through, never logged. */
function incomingFromEntry(entry: HistoryEntry, cid: string): IncomingRecord {
	const kind = kindOfBody(entry.body)
	const rec: IncomingRecord = {
		convKey: entry.peer.toLowerCase(),
		dir: entry.dir,
		sortTs: entry.ts,
		sendId: entry.sendId ?? null,
		kind,
		body: entry.body,
		cid: cid || null,
		revision: 0,
	}
	if (kind === 'image' || kind === 'video') {
		const fm = (JSON.parse(entry.body) as { fileMessage?: { mime?: string; width?: number; height?: number } }).fileMessage ?? {}
		rec.media = { cid: cid, mime: fm.mime ?? '', widthPx: fm.width, heightPx: fm.height, state: 'pending' }
	}
	return rec
}

export class HistoryStore {
	private master: Uint8Array | null = null
	private indexKey: Uint8Array | null = null
	private genesisCid = ''
	private manifest: IndexManifest | null = null
	private eoaLower = ''
	private ready = false
	/** Cached signer + its self-address EIP-191 signature (storageFragment auth). */
	private wallet: AccountSigning | null = null
	private selfSign = ''
	/** Lazily-created read-only CoNET provider (RPC-first pointer reads). */
	private provider: ethers.JsonRpcProvider | null = null
	private mutationChain: Promise<void> = Promise.resolve()
	/** Decrypted corpus. Keyed by fragment cid so a known body is never fetched again. */
	private corpus = new Map<string, PlainRecord>()
	/** Last on-chain index hash already merged into the local manifest. */
	private syncedIndexHash = ''
	/** Encrypted local library. Opened lazily after `init`; never waits on the network. */
	private localStore: LocalChatStore | null = null
	private localReady: Promise<LocalChatStore> | null = null
	/** K_id, K_idx and DEK from the wallet layer (never R_db or P). */
	private localKeys: { kId: Uint8Array; kIdx: Uint8Array; dek: Uint8Array } | null = null
	private localDbNameCache = ''
	/** False once migration is `complete`: no new plaintext copies in the legacy kv. */
	private plainCacheEnabled = true
	private plainPurgeScheduled = false
	/** the cold-start check "does the library hold fewer rows than the index has records" runs once per worker session */
	private coldReconcileScheduled = false
	/** the promise of that check (tests await it; nothing else reads it) */
	private coldReconcileDone: Promise<void> | null = null
	private unboundedReads = 0

	constructor(
		private readonly emit: HistoryEmit,
		private readonly opts: {
			eoaAddress: string
			/** Host-backed signer (no key in the worker). */
			signing: AccountSigning
			chainId: number
			ipfsBaseUrl: string
			ipfsWriteBaseUrl?: string
			conetRpcUrl: string
			chatIndexRegistryAddress: string
			apiBaseUrl?: string
			persistence?: PersistenceAdapter
			/** the cross-tab lock of one account's history (default: Web Locks). With none, the local copy is still written but NOTHING is published. */
			accountLock?: HistoryAccountLock
		},
	) {}

	private accountLock: HistoryAccountLock | undefined | null = null
	private lockOfAccount(): HistoryAccountLock | undefined {
		if (this.accountLock === null) this.accountLock = this.opts.accountLock ?? browserAccountLock()
		return this.accountLock
	}
	/** one change of this account's history at a time: in this worker (the chain) and across tabs (the account lock) */
	private async mutate(fn: () => Promise<void>): Promise<void> {
		this.mutationChain = this.mutationChain.catch(() => undefined).then(async () => {
			await this.init()
			const lock = this.lockOfAccount()
			if (lock) await lock(`beamio-chat-history:${this.eoaLower}`, fn)
			else await fn()
		})
		await this.mutationChain
	}
	/** the head the local index was last brought up to (null: the wallet had none) */
	private baseHead: string | null = null
	/** the sendIds and fragment ids of the last head that was read and opened */
	private headKeys = new Set<string>()

	private get writeBase(): string {
		return (this.opts.ipfsWriteBaseUrl || this.opts.ipfsBaseUrl).replace(/\/$/, '')
	}
	private get readBase(): string {
		return this.opts.ipfsBaseUrl.replace(/\/$/, '')
	}
	private getProvider(): ethers.JsonRpcProvider {
		if (!this.provider) {
			const net = new ethers.Network('conet', REGISTRY_CHAIN_ID)
			this.provider = new ethers.JsonRpcProvider(this.opts.conetRpcUrl, net, { staticNetwork: net })
		}
		return this.provider
	}

	async init(): Promise<void> {
		if (this.ready) return
		this.eoaLower = this.opts.eoaAddress.toLowerCase()
		const wallet = this.opts.signing
		this.wallet = wallet
		// storageFragment auth message = the wallet's own address (checkSign(wallet, sig, wallet)).
		this.selfSign = await wallet.signMessage(wallet.address)
		// The host signer must be this account; a mismatch would mint records under the wrong owner.
		if (ethers.verifyMessage(wallet.address, this.selfSign).toLowerCase() !== this.eoaLower) {
			throw new Error('account_signer_address_mismatch')
		}
		const domain = `beamio.chat.history.v1|${this.opts.chainId}|${this.eoaLower}`
		const sig = await wallet.signMessage(domain)
		this.master = hexToBytes(keccakUtf8(sig))
		this.indexKey = await hkdf(this.master, 'index-enc', 32)
		const genesisBytes = await hkdf(this.master, FRAGMENT_GENESIS_INFO, 32)
		this.genesisCid = ethers.hexlify(genesisBytes)
		this.ready = true
	}

	// ---- On-chain head pointer / index ---------------------------------------
	/** Local mirror is keyed per-EOA (index cipher changes each append). */
	private localIndexKey(): string {
		return `${LOCAL_INDEX_KEY_PREFIX}${this.eoaLower}`
	}

	/** Read the on-chain head pointer (RPC-first). Returns null when unset/unreachable. */
	private async readOnchainPointer(): Promise<{ indexHash: string; ts: bigint; seq: bigint } | null> {
		try {
			const registry = new ethers.Contract(
				this.opts.chatIndexRegistryAddress,
				REGISTRY_READ_ABI,
				this.getProvider(),
			)
			const ptr = await registry.getPointer!(ethers.getAddress(this.eoaLower))
			const indexHash = String(ptr[0])
			if (!indexHash || indexHash === ethers.ZeroHash) return null
			this.emit.log(
				'info',
				`[history] pointer index=${diagnosticCid(indexHash)} seq=${ptr[2].toString()} ts=${ptr[1].toString()}`,
			)
			return { indexHash, ts: BigInt(ptr[1].toString()), seq: BigInt(ptr[2].toString()) }
		} catch (ex) {
			// a failed read is not "there is no head": it throws, and nothing may be published over a head that was not read
			this.emit.log('warn', `[history] pointer read failed: ${(ex as Error)?.message ?? String(ex)}`)
			throw new Error('pointer_read_failed')
		}
	}

	/** Fetch the encrypted index cipher by its content hash. */
	private async fetchIndexCipherByHash(indexHash: string): Promise<string | null> {
		try {
			const url = `${this.readBase}/getFragment?hash=${encodeURIComponent(indexHash)}`
			const res = await fetch(url, { method: 'GET', cache: 'no-store' })
			if (!res.ok) {
				this.emit.log('warn', `[history] index fetch failed hash=${diagnosticCid(indexHash)} http=${res.status}`)
				return null
			}
			const text = (await res.text()).trim()
			this.emit.log(
				'info',
				`[history] index fetched hash=${diagnosticCid(indexHash)} chars=${text.length}`,
			)
			return text || null
		} catch {
			this.emit.log('warn', `[history] index fetch threw hash=${diagnosticCid(indexHash)}`)
			return null
		}
	}

	private async loadLocalManifest(): Promise<IndexManifest | null> {
		// Local-first (instant open).
		if (this.opts.persistence) {
			const cached = (await this.opts.persistence.get(this.localIndexKey())) as string | undefined
			if (cached && this.indexKey) {
				try {
					const json = await aesGcmDecryptString(this.indexKey, cached)
					const parsed = JSON.parse(json) as IndexManifest
					if (parsed?.v === 1) this.manifest = parsed
				} catch {
					/* corrupt local; fall through to network */
				}
			}
		}
		return this.manifest
	}

	private recordKey(record: IndexRecord): string {
		return record.sendId ? `send:${record.sendId}` : `cid:${record.cid}`
	}

	private unionMergeRecords(local: IndexRecord[], remote: IndexRecord[]): IndexRecord[] {
		const byKey = new Map<string, IndexRecord>()
		for (const record of [...local, ...remote]) {
			const key = this.recordKey(record)
			if (!byKey.has(key)) byKey.set(key, record)
		}
		return [...byKey.values()].sort((a, b) => a.seq - b.seq || a.cid.localeCompare(b.cid))
	}

	private hasChainConflict(local: IndexRecord[], remote: IndexRecord[], merged: IndexRecord[]): boolean {
		const seqToCid = new Map<number, string>()
		const prevToCid = new Map<string, string>()
		for (const record of [...local, ...remote]) {
			const prior = seqToCid.get(record.seq)
			if (prior && prior !== record.cid) return true
			seqToCid.set(record.seq, record.cid)
			const fork = prevToCid.get(record.prevCid)
			if (fork && fork !== record.cid) return true
			prevToCid.set(record.prevCid, record.cid)
		}
		const ordered = [...merged].sort((a, b) => a.seq - b.seq)
		return ordered.some((record, index) => {
			const previous = index === 0 ? this.genesisCid : ordered[index - 1].cid
			return record.seq !== index || record.prevCid !== previous
		})
	}

	private async decryptRecord(record: IndexRecord): Promise<HistoryEntry | null> {
		const { entry } = await this.materializeRecord(record)
		return entry
	}

	/** null only when a body is missing (the records cannot be re-linearised). An upload that fails does NOT stop the merge: the new records are kept on this device and `uploaded` says that nothing may be published now. */
	private async relinearizeAndReencrypt(records: IndexRecord[]): Promise<{ records: IndexRecord[]; uploaded: boolean } | null> {
		const decrypted = await Promise.all(
			records.map(async (record) => ({ record, body: await this.decryptRecord(record) })),
		)
		if (decrypted.some(({ body }) => !body)) return null
		const ordered = decrypted
			.map(({ record, body }) => ({ record, body: body! }))
			.sort(
				(a, b) =>
					a.body.ts - b.body.ts ||
					String(a.body.sendId || '').localeCompare(String(b.body.sendId || '')) ||
					a.record.cid.localeCompare(b.record.cid),
			)
		const next: IndexRecord[] = []
		let uploaded = true
		for (const { record, body } of ordered) {
			const seq = next.length
			const prevCid = seq ? next[seq - 1].cid : this.genesisCid
			const cipher = await aesGcmEncryptString(await this.fragmentKey(seq, prevCid), body.body)
			const cid = keccakUtf8(cipher)
			if (this.opts.persistence) await this.opts.persistence.set(`${LOCAL_FRAG_KEY_PREFIX}${cid}`, cipher)
			if (uploaded && !(await this.uploadFragment(cipher))) uploaded = false // the next sync re-linearises again (the local list differs from the head) and uploads everything before anything is published
			next.push({
				...record,
				seq,
				cid,
				prevCid,
				peer: body.peer.toLowerCase(),
				ts: body.ts,
				dir: body.dir,
				//relinearize moves seq and cid only; the index sendId (the sendKey after D10) is kept as is
				sendId: record.sendId ?? body.sendId,
				preview: body.body.slice(0, 80),
			})
		}
		return { records: next, uploaded }
	}

	private async syncFromHeadUnlocked(): Promise<boolean> {
		await this.init()
		await this.loadLocalManifest()
		let pointer: { indexHash: string; ts: bigint; seq: bigint } | null
		try {
			pointer = await this.readOnchainPointer()
		} catch {
			return this.headNotSynced()
		}
		if (!pointer) { this.baseHead = null; this.headKeys = new Set(); return false } // a confirmed empty head: nothing to merge
		if (!this.indexKey) return this.headNotSynced()
		if (this.syncedIndexHash && pointer.indexHash === this.syncedIndexHash && this.manifest) { this.baseHead = pointer.indexHash; return false }
		const cipher = await this.fetchIndexCipherByHash(pointer.indexHash)
		if (!cipher) return this.headNotSynced()
		try {
			const parsed = JSON.parse(await aesGcmDecryptString(this.indexKey, cipher)) as IndexManifest
			if (parsed?.v !== 1 || parsed.eoa?.toLowerCase() !== this.eoaLower) {
				this.emit.log('warn', '[history] index rejected: version or EOA mismatch')
				return this.headNotSynced()
			}
			const local = this.manifest?.records ?? []
			const remote = Array.isArray(parsed.records) ? parsed.records : []
			this.headKeys = new Set(remote.flatMap((r) => (r.sendId ? [r.sendId, r.cid] : [r.cid])))
			const merged = this.unionMergeRecords(local, remote)
			this.emit.log(
				'info',
				`[history] index decrypted remoteRecords=${remote.length} localRecords=${local.length} mergedRecords=${merged.length}`,
			)
			const linear = this.hasChainConflict(local, remote, merged)
				? await this.relinearizeAndReencrypt(merged)
				: { records: merged, uploaded: true }
			const records = linear?.records
			if (!linear || !records) {
				this.emit.log('warn', '[history] index chain conflict could not be relinearized')
				return this.headNotSynced()
			}
			// the head is read, opened and merged: only now is it what a publication builds on
			this.baseHead = pointer.indexHash
			const changed =
				records.length !== local.length || records.some((record, index) => record.cid !== local[index]?.cid)
			if (!changed) {
				this.syncedIndexHash = pointer.indexHash
				return false
			}
			const nextManifest = { ...parsed, updatedAt: Date.now(), records }
			// The remote index already holds exactly these records (same order, same cids): adopt it locally.
			// Re-uploading it would only mint a new cipher for the same content and move the on-chain pointer again
			// (a storageFragment write and a relayed pointer write on every fresh device or cleared mirror).
			const sameAsRemote = records.length === remote.length && records.every((record, index) => record.cid === remote[index]?.cid)
			if (sameAsRemote) {
				if (this.opts.persistence && this.indexKey) {
					const localCipher = await aesGcmEncryptString(this.indexKey, JSON.stringify(nextManifest))
					await this.opts.persistence.set(this.localIndexKey(), localCipher)
				}
				this.manifest = nextManifest
				this.syncedIndexHash = pointer.indexHash
				return true
			}
			// RESTORE first: the merged records are adopted on this device (shown, and kept across a restart) whatever happens to the publication. A publication that cannot be completed only means that nothing is published.
			await this.persistManifestLocal(nextManifest)
			this.manifest = nextManifest
			const published = linear.uploaded && (await this.persistManifest(nextManifest, { requireRemoteCommit: Boolean(this.opts.apiBaseUrl) }))
			if (!published) {
				this.headNotSynced()
				return true // the local index changed
			}
			this.syncedIndexHash = pointer.indexHash
			return true
		} catch (ex) {
			this.emit.log('warn', `[history] index decrypt/parse failed: ${(ex as Error)?.message ?? String(ex)}`)
			return this.headNotSynced()
		}
	}

	/** set by a head sync that could not read or merge the head (the return value of the sync only says whether the local index changed) */
	private headSyncFailed = false
	private headNotSynced(): false {
		this.headSyncFailed = true
		return false
	}
	/** Brings the local index up to the head before anything is published. false: the head could not be read or merged: publish nothing. Runs inside the mutation chain. */
	private async syncHeadForPublish(): Promise<boolean> {
		this.headSyncFailed = false
		try {
			await this.syncFromHeadUnlocked()
		} catch (ex) {
			this.emit.log('warn', `[history] head sync failed: ${(ex as Error)?.message ?? String(ex)}`)
			return false
		}
		return !this.headSyncFailed
	}

	/** Union-sync the local mirror with the current on-chain head. */
	async syncFromHead(): Promise<boolean> {
		let result = false
		await this.mutate(async () => {
			result = await this.syncFromHeadUnlocked()
		})
		return result
	}

	private async persistManifest(
		nextManifest: IndexManifest = this.manifest!,
		options?: { requireRemoteCommit?: boolean },
	): Promise<boolean> {
		if (!nextManifest || !this.indexKey) return false
		const json = JSON.stringify(nextManifest)
		const cipher = await aesGcmEncryptString(this.indexKey, json)
		// The remote index may only name a record that is still pending a remote commit once its fragment is uploaded; otherwise nothing is published (the local copy is still written below).
		const publishable = await this.uploadPendingFragmentsOf(nextManifest)
		// Upload the fresh index cipher as a content-addressed fragment, then move the on-chain head pointer.
		const indexHash = publishable ? await this.uploadFragment(cipher) : null
		const requiresRemoteCommit = Boolean(options?.requireRemoteCommit && this.opts.apiBaseUrl)
		if (requiresRemoteCommit && (!indexHash || !(await this.updateOnchainPointer(indexHash, nextManifest)))) {
			return false
		}
		// Only publish the local manifest after the remote commit when sync requires one.
		if (this.opts.persistence) await this.opts.persistence.set(this.localIndexKey(), cipher)
		this.manifest = nextManifest
		if (!requiresRemoteCommit && indexHash) await this.updateOnchainPointer(indexHash, nextManifest)
		return Boolean(indexHash)
	}

	/** Uploads the fragments of the pending records that `manifest` names. false: one of them could not be uploaded, or the pending list cannot be read (then nothing may be published). The pending list is not changed. */
	private async uploadPendingFragmentsOf(manifest: IndexManifest): Promise<boolean> {
		try {
			for (const p of await this.readRemotePending()) {
				if (!manifest.records.some((r) => r.cid === p.cid)) continue // not named by this index (a re-linearised record has a new fragment, uploaded when it was made)
				const frag = this.opts.persistence ? ((await this.opts.persistence.get(`${LOCAL_FRAG_KEY_PREFIX}${p.cid}`)) as string | undefined) : undefined
				if (!frag || !(await this.uploadFragment(frag))) return false
			}
			return true
		} catch (ex) {
			this.emit.log('warn', `[history] index not published: pending records cannot be checked (${(ex as Error)?.message === 'remote_pending_unreadable' ? 'unreadable' : 'read_failed'})`)
			return false
		}
	}

	/**
	 * Move the EOA's on-chain head pointer to `indexHash` via the gasless relay.
	 * The EOA signs `SetPointer(owner,indexHash,ts,seq,nonce)` (EIP-712); the API relayer pays gas.
	 * No-op (with a warning) when `apiBaseUrl` is not configured.
	 */
	private async updateOnchainPointer(indexHash: string, manifest: IndexManifest = this.manifest!): Promise<boolean> {
		if (!this.wallet) return false
		if (!this.lockOfAccount()) {
			this.emit.log('warn', '[history] pointer not written: no cross-tab lock in this runtime')
			return false
		}
		if (!this.opts.apiBaseUrl) {
			this.emit.log('warn', 'chat history: apiBaseUrl unset — on-chain head pointer not updated')
			return false
		}
		if (!ethers.isHexString(indexHash, 32)) {
			this.emit.log('warn', `chat history: bad indexHash ${indexHash}`)
			return false
		}
		try {
			// head and nonce from ONE block of one node, immediately before the signature: a head that moved since the local index was built is not written over
			const snapshot = await this.readPublishSnapshot()
			if (snapshot.head !== null && snapshot.head.toLowerCase() === indexHash.toLowerCase()) {
				// this very index is the head already (an earlier confirmation was lost): the same bookkeeping as a publication
				this.notePublishedHead(indexHash, manifest)
				return true
			}
			if ((snapshot.head?.toLowerCase() ?? null) !== (this.baseHead?.toLowerCase() ?? null)) {
				this.emit.log('warn', '[history] pointer not signed: the head moved since this index was built')
				this.syncedIndexHash = '' // the next attempt reads and merges the head again
				return false
			}
			const nonce = snapshot.nonce
			// ts = client monotonic timestamp (ms); seq = monotonic append count. Both non-decreasing.
			const ts = BigInt(Date.now())
			const seq = BigInt(manifest.records?.length ?? 0)
			const domain = {
				name: 'ChatIndexRegistry',
				version: '1',
				chainId: REGISTRY_CHAIN_ID,
				verifyingContract: this.opts.chatIndexRegistryAddress,
			}
			const value = { owner: this.wallet.address, indexHash, ts, seq, nonce: BigInt(nonce.toString()) }
			const signature = await this.wallet.signTypedData(domain, SET_POINTER_TYPES as never, value)
			const base = this.opts.apiBaseUrl.replace(/\/$/, '')
			const res = await fetch(`${base}/setChatIndexPointer`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					owner: this.wallet.address,
					indexHash,
					ts: ts.toString(),
					seq: seq.toString(),
					nonce: nonce.toString(),
					signature,
				}),
				signal: remoteStepSignal(this.remoteStepTimeoutMs),
			})
			if (!res.ok) {
				this.emit.log('warn', `setChatIndexPointer HTTP ${res.status}`)
				return false
			}
			// a 2xx status alone is not accepted: only a JSON body with success === true (anything else, a missing field or a body that is not JSON included, is a failure)
			const answer = (await res.json().catch(() => null)) as { success?: unknown } | null
			if (answer?.success !== true) {
				this.emit.log('warn', 'setChatIndexPointer answered without success:true')
				return false
			}
			this.notePublishedHead(indexHash, manifest)
			return true
		} catch (ex) {
			this.emit.log('warn', `updateOnchainPointer error: ${(ex as Error)?.message ?? String(ex)}`)
			return false
		}
	}

	/** a published index is what the next publication builds on, and it names these records */
	private notePublishedHead(indexHash: string, manifest: IndexManifest): void {
		this.baseHead = indexHash
		this.headKeys = new Set(manifest.records.flatMap((r) => (r.sendId ? [r.sendId, r.cid] : [r.cid])))
	}

	/** the registry's head and this account's nonce at one block */
	private async readPublishSnapshot(): Promise<{ head: string | null; nonce: bigint }> {
		const provider = this.getProvider()
		const blockTag = await provider.getBlockNumber()
		const registry = new ethers.Contract(this.opts.chatIndexRegistryAddress, REGISTRY_READ_ABI, provider)
		const owner = ethers.getAddress(this.eoaLower)
		const [pointer, nonce] = await Promise.all([registry.getPointer!(owner, { blockTag }), registry.nonceOf!(owner, { blockTag })])
		const head = String(pointer[0])
		return { head: !head || head === ethers.ZeroHash ? null : head, nonce: BigInt(nonce.toString()) }
	}

	// ---- Fragment upload/download --------------------------------------------
	private async uploadFragment(cipherB64: string): Promise<string | null> {
		if (!this.wallet) throw new Error('history not initialised')
		const contentHash = keccakUtf8(cipherB64)
		// storageFragment contract: { wallet, signMessage, image }. `image` is the raw
		// content whose keccak256(toUtf8Bytes(image)) the server recomputes as the hash.
		const body: Record<string, unknown> = {
			wallet: this.wallet.address,
			signMessage: this.selfSign,
			image: cipherB64,
		}
		try {
			const res = await fetch(`${this.writeBase}/storageFragment`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: remoteStepSignal(this.remoteStepTimeoutMs),
			})
			if (!res.ok) {
				this.emit.log('warn', `uploadFragment HTTP ${res.status}`)
				return null
			}
			// a success status alone is not accepted: the upload counts only once the content reads back by its hash, byte for byte
			return (await this.readsBack(contentHash, cipherB64)) ? contentHash : null
		} catch (ex) {
			this.emit.log('warn', `uploadFragment error: ${(ex as Error)?.message ?? String(ex)}`)
			return null
		}
	}

	/**
	 * Read-back after upload: fetches `hash` from the read endpoint, never from this device's own copy and never from an HTTP cache (no-store and a URL used once), and compares the bytes with what was uploaded.
	 * Nothing found, a non-2xx answer, a timeout (the signal also covers the body) or any difference is `false`.
	 */
	private async readsBack(hash: string, uploaded: string): Promise<boolean> {
		try {
			const url = `${this.readBase}/getFragment?hash=${encodeURIComponent(hash)}&rb=${Date.now().toString(36)}-${(this.readBackSequence += 1).toString(36)}-${Math.random().toString(36).slice(2, 10)}`
			const res = await fetch(url, { method: 'GET', cache: 'no-store', signal: remoteStepSignal(this.remoteStepTimeoutMs) })
			if (res.status !== 200) {
				this.emit.log('warn', `uploadFragment read-back HTTP ${res.status}`)
				return false
			}
			const got = new Uint8Array(await res.arrayBuffer())
			const want = utf8(uploaded)
			const same = got.length === want.length && got.every((byte, index) => byte === want[index])
			if (!same) this.emit.log('warn', `uploadFragment read-back differs bytes=${got.length} expected=${want.length}`)
			return same
		} catch (ex) {
			this.emit.log('warn', `uploadFragment read-back error: ${(ex as Error)?.message ?? String(ex)}`)
			return false
		}
	}
	private readBackSequence = 0

	private async downloadFragment(cid: string): Promise<string | null> {
		// Local mirror first.
		if (this.opts.persistence) {
			const cached = (await this.opts.persistence.get(`${LOCAL_FRAG_KEY_PREFIX}${cid}`)) as string | undefined
			if (cached) return cached
		}
		try {
			const url = `${this.readBase}/getFragment?hash=${encodeURIComponent(cid)}`
			const res = await fetch(url, { method: 'GET', cache: 'no-store' })
			if (!res.ok) {
				this.emit.log('warn', `[history] fragment fetch failed cid=${diagnosticCid(cid)} http=${res.status}`)
				return null
			}
			const text = (await res.text()).trim()
			this.emit.log('info', `[history] fragment fetched cid=${diagnosticCid(cid)} chars=${text.length}`)
			if (text && this.opts.persistence) await this.opts.persistence.set(`${LOCAL_FRAG_KEY_PREFIX}${cid}`, text)
			return text || null
		} catch (ex) {
			this.emit.log('warn', `[history] fragment fetch threw cid=${diagnosticCid(cid)}: ${(ex as Error)?.message ?? String(ex)}`)
			return null
		}
	}

	private async fragmentKey(seq: number, prevCid: string): Promise<Uint8Array> {
		if (!this.master) throw new Error('history not initialised')
		return hkdf(this.master, `frag|${seq}|${prevCid}`, 32)
	}

	private plainKey(cid: string): string {
		return `${LOCAL_PLAIN_KEY_PREFIX}${this.eoaLower}:${cid}`
	}

	private async rememberPlain(cid: string, entry: HistoryEntry): Promise<void> {
		const row: PlainRecord = { entry, searchText: extractSearchText(entry.body) }
		this.corpus.set(cid, row)
		if (this.opts.persistence && this.plainCacheEnabled) await this.opts.persistence.set(this.plainKey(cid), row)
	}

	/** Memory, then local plaintext, then local cipher, then IPFS. A hit never reaches the next step. */
	private async materializeRecord(rec: IndexRecord): Promise<{ entry: HistoryEntry | null; fresh: boolean }> {
		const known = this.corpus.get(rec.cid)
		if (known) return { entry: known.entry, fresh: false }
		// the plaintext key is read only while the cache is enabled (migration period); a library account never answers from a plaintext copy
		if (this.opts.persistence && this.plainCacheEnabled) {
			const stored = await this.opts.persistence.get(this.plainKey(rec.cid))
			if (isPlainRecord(stored)) {
				this.corpus.set(rec.cid, stored)
				return { entry: stored.entry, fresh: false }
			}
		}
		const cipher = await this.downloadFragment(rec.cid)
		if (!cipher) {
			this.emit.log('warn', `[history] record unavailable seq=${rec.seq} cid=${diagnosticCid(rec.cid)}`)
			return { entry: null, fresh: false }
		}
		try {
			const key = await this.fragmentKey(rec.seq, rec.prevCid)
			const body = await aesGcmDecryptString(key, cipher)
			const entry: HistoryEntry = {
				seq: rec.seq,
				ts: rec.ts,
				peer: rec.peer,
				dir: rec.dir,
				sendId: rec.sendId,
				body,
			}
			await this.rememberPlain(rec.cid, entry)
			return { entry, fresh: true }
		} catch (ex) {
			this.emit.log(
				'warn',
				`[history] record decrypt failed seq=${rec.seq} cid=${diagnosticCid(rec.cid)} prev=${diagnosticCid(rec.prevCid)}: ${(ex as Error)?.message ?? String(ex)}`,
			)
			return { entry: null, fresh: false }
		}
	}

	private matchesQuery(cid: string, query: string): boolean {
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
		if (!terms.length) return true
		const text = this.corpus.get(cid)?.searchText ?? ''
		return terms.every((term) => text.includes(term))
	}

	// ---- Public: load / append -----------------------------------------------
	async load(options?: HistoryLoadOptions): Promise<void> {
		await this.init()
		const tailCount = options?.tailCount ?? 60
		const localOnly = options?.localOnly ?? false
		const emitMode = options?.emit ?? 'fresh'
		const peerFilter = options?.peer ? options.peer.toLowerCase() : undefined

		await this.loadLocalManifest()
		if (!localOnly) await this.syncFromHead()
		const manifest = this.manifest
		if (!manifest?.records?.length) {
			this.emit.buffer(peerFilter ?? 'all', [], true)
			return
		}
		let records = manifest.records
		if (peerFilter) records = records.filter((r) => r.peer.toLowerCase() === peerFilter)
		if (!records.length) {
			this.emit.buffer(peerFilter ?? 'all', [], true)
			return
		}
		const ordered = [...records].sort((a, b) => a.seq - b.seq)
		const tail = ordered.slice(Math.max(0, ordered.length - tailCount))
		const older = ordered.slice(0, Math.max(0, ordered.length - tailCount))
		this.emit.log(
			'info',
			`[history] load peer=${peerFilter ?? 'all'} records=${ordered.length} tail=${tail.length} older=${older.length}`,
		)

		const publish = async (recordsToOpen: IndexRecord[], isTail: boolean): Promise<void> => {
			const opened = await Promise.all(recordsToOpen.map((record) => this.materializeRecord(record)))
			const entries = opened
				.filter((row) => row.entry && (emitMode === 'all' || row.fresh))
				.map((row) => row.entry!)
			const freshCount = opened.filter((row) => row.fresh).length
			this.emit.log(
				'info',
				`[history] corpus ${isTail ? 'tail' : 'backfill'} records=${recordsToOpen.length} fresh=${freshCount} emitted=${entries.length}`,
			)
			if (entries.length) this.emit.buffer(peerFilter ?? 'all', entries, isTail)
		}

		await publish(tail, true)
		const batchSize = 20
		for (let i = older.length; i > 0; i -= batchSize) {
			const slice = older.slice(Math.max(0, i - batchSize), i)
			await publish(slice, false)
		}
	}

	/**
	 * Global read of the decrypted corpus. Does not refresh the on-chain pointer.
	 * Missing bodies are decrypted once and stored; later reads stay local.
	 */
	async read(options?: HistoryReadOptions): Promise<HistoryEntry[]> {
		if (!options?.limit) {
			this.unboundedReads += 1
			this.emit.log('info', `historyRead.unbounded caller=${options?.caller ?? 'unknown'} count=${this.unboundedReads}`)
		}
		let result: HistoryEntry[] = []
		this.mutationChain = this.mutationChain.catch(() => undefined).then(async () => {
			await this.init()
			await this.loadLocalManifest()
			const peer = options?.peer?.toLowerCase()
			const query = options?.query?.trim() ?? ''
			const records = (this.manifest?.records ?? []).filter((record) => !peer || record.peer.toLowerCase() === peer)
			const entries: HistoryEntry[] = []
			let fresh = 0
			for (const record of records) {
				const opened = await this.materializeRecord(record)
				if (opened.fresh) fresh += 1
				if (!opened.entry) continue
				if (query && !this.matchesQuery(record.cid, query)) continue
				entries.push(opened.entry)
			}
			entries.sort((a, b) => a.ts - b.ts || a.seq - b.seq)
			const limit = options?.limit
			result = limit && limit > 0 ? entries.slice(-limit) : entries
			this.emit.log(
				'info',
				`[history] read records=${records.length} fresh=${fresh} matches=${result.length}${query ? ' query=1' : ''}`,
			)
		})
		await this.mutationChain
		return result
	}

	/** sendIds whose library row this worker session has made sure of (a bounded memo, so a re-mirror storm costs one idempotent ingest per message at most) */
	private libraryEnsured = new Set<string>()

	/**
	 * an append for a sendId that is already in the index must still leave the library row behind. A page or worker killed between the manifest write and the library ingest (the half-way append) leaves the
	 * record in the index and no row in the library; the retry (the page's back-off retry, or the mailbox redelivery after the next listen) would otherwise find the sendId and return, and the mailbox ACK that follows
	 * would then rest on an index record with no library row. The library ingest is idempotent (same stable id: no second row), local only, and once per sendId per worker session. Best-effort like the ingest after a new record.
	 */
	private async ensureLibraryRow(entry: Omit<HistoryEntry, 'seq'>, sid: string): Promise<void> {
		if (this.libraryEnsured.has(sid)) return
		const rec = this.manifest?.records?.find((r) => r.sendId === sid)
		if (!rec) return
		const confirmed = await this.ingestLocalAppend({ peer: entry.peer, dir: entry.dir, ts: entry.ts, sendId: sid, body: entry.body }, rec.cid)
		await this.requireRowOrThrow(confirmed) // a failed write is not remembered: the next retry tries again
		if (!confirmed) return
		this.libraryEnsured.add(sid)
		if (this.libraryEnsured.size > 5000) {
			const oldest = this.libraryEnsured.values().next().value
			if (oldest) this.libraryEnsured.delete(oldest)
		}
	}

	// ---- a record's remote commit (fragment upload + index upload + on-chain pointer) before the mailbox ACK -----------------------------------------------------------------------
	/** an INBOUND record's append only resolves once its remote commit succeeded (the page's mailbox ACK rests on it); outbound mirrors stay best effort; no apiBaseUrl: no remote exists */
	private remoteRequiredFor(entry: { dir: 'in' | 'out' }): boolean {
		return Boolean(this.opts.apiBaseUrl) && entry.dir === 'in'
	}
	private remotePendingKey(): string {
		return `${LOCAL_REMOTE_PENDING_PREFIX}${this.eoaLower}`
	}
	/** "cannot read" is never "nothing pending": a failed read or a damaged value THROWS (the append is then not confirmed and the stored value is not overwritten); only an absent value is an empty list */
	private async readLegacyPending(): Promise<Array<{ cid: string; sendId?: string }>> {
		if (!this.opts.persistence) return this.remotePendingMemory
		const raw = await this.opts.persistence.get(this.remotePendingKey())
		if (raw === undefined || raw === null || raw === '') return []
		let list: unknown
		try {
			list = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
		} catch {
			throw new Error('remote_pending_unreadable')
		}
		if (!Array.isArray(list) || !list.every((x): x is { cid: string; sendId?: string } => !!x && typeof (x as { cid?: unknown }).cid === 'string')) throw new Error('remote_pending_unreadable')
		return list
	}
	private pendingRecordName(cid: string): string {
		return `${LOCAL_PENDING_RECORD_PREFIX}${this.eoaLower}:${keccakUtf8(cid).slice(2, 34)}`
	}
	/** every pending record: the per-record documents and the single list. A listing or a document that cannot be read THROWS. */
	private async readRemotePending(): Promise<Array<{ cid: string; sendId?: string }>> {
		const list = [...(await this.readLegacyPending())]
		const store = this.opts.persistence
		if (!store?.keys) return list
		for (const name of await store.keys(`${LOCAL_PENDING_RECORD_PREFIX}${this.eoaLower}:`)) {
			const raw = await store.get(name)
			let item: { cid?: unknown; sendId?: string } | null = null
			try { item = typeof raw === 'string' ? (JSON.parse(raw) as { cid?: unknown; sendId?: string }) : null } catch { item = null }
			if (!item || typeof item.cid !== 'string') {
				if (raw === undefined && !(await store.keys(name)).includes(name)) continue // removed since the listing
				throw new Error('remote_pending_unreadable')
			}
			if (!list.some((x) => x.cid === item!.cid)) list.push(item as { cid: string; sendId?: string })
		}
		return list
	}
	/** a value that must be on disk: written, then read back (a store may ignore a failed write) */
	private async storeVerified(name: string, value: string): Promise<void> {
		if (!this.opts.persistence) return
		await this.opts.persistence.set(name, value)
		if ((await this.opts.persistence.get(name)) !== value) throw new Error('persist_not_stored')
	}
	/** memory twin of the durable list for a store with no persistence (tests, a client without storage) */
	private remotePendingMemory: Array<{ cid: string; sendId?: string }> = []
	/** how long one remote step may take (a test sets it short) */
	private remoteStepTimeoutMs = REMOTE_STEP_TIMEOUT_MS
	private async addRemotePending(cid: string, sendId: string | undefined): Promise<void> {
		const item = { cid, ...(sendId ? { sendId } : {}) }
		if (!this.opts.persistence?.keys) {
			const list = await this.readRemotePending()
			if (list.some((x) => x.cid === cid)) return
			this.remotePendingMemory = [...list, item]
			await this.storeVerified(this.remotePendingKey(), JSON.stringify(this.remotePendingMemory))
			return
		}
		await this.storeVerified(this.pendingRecordName(cid), JSON.stringify(item))
	}
	/** removes exactly these pending records, each by its own name; the others are not rewritten */
	private async clearRemotePending(done: Array<{ cid: string; sendId?: string }>): Promise<void> {
		const gone = new Set(done.map((x) => x.cid))
		const legacy = await this.readLegacyPending()
		const left = legacy.filter((x) => !gone.has(x.cid))
		this.remotePendingMemory = left
		if (this.opts.persistence && left.length !== legacy.length) await this.opts.persistence.set(this.remotePendingKey(), JSON.stringify(left))
		if (this.opts.persistence?.keys) for (const cid of gone) await this.opts.persistence.delete(this.pendingRecordName(cid))
	}
	private publishedName(id: string): string {
		return `${LOCAL_PUBLISHED_PREFIX}${this.eoaLower}:${keccakUtf8(id).slice(2, 34)}`
	}
	private publishedMemory = new Set<string>()
	/** positive evidence only: the last head read holds the record, or a publication of a head holding it was recorded. A read that fails answers false. */
	private async isPublished(id: string): Promise<boolean> {
		if (this.headKeys.has(id)) return true
		if (!this.opts.persistence) return this.publishedMemory.has(id)
		return (await this.opts.persistence.get(this.publishedName(id))) === '1'
	}
	private async notePublished(ids: Iterable<string>): Promise<void> {
		for (const id of ids) {
			this.publishedMemory.add(id)
			// a mark that cannot be stored only means one more commit later
			if (this.opts.persistence) await this.opts.persistence.set(this.publishedName(id), '1').catch(() => undefined)
		}
	}
	/**
	 * Uploads the fragment of EVERY pending record (from the local cipher cache), then the index, then moves the on-chain pointer. All three must succeed (a failure, a timeout or a non-2xx is the failing step); only then is the
	 * pending list cleared. The local copy is never touched here (nothing is deleted or rolled back on a failure).
	 */
	private async commitRemoteAll(qaFault?: 'upload' | 'pointer' | 'timeout', required?: { cid?: string; sendId?: string }): Promise<RemoteCommitStep> {
		if (!this.manifest || !this.indexKey) return 'index_upload'
		const holdsRequired = (records: ReadonlyArray<{ cid: string; sendId?: string }>): boolean => !required || records.some((r) => (!!required.cid && r.cid === required.cid) || (!!required.sendId && r.sendId === required.sendId))
		// the record this append is about must be in the index; otherwise nothing is confirmed (the retry stores it again)
		if (!holdsRequired(this.manifest.records)) return 'record_missing'
		// all three or no confirmation: the LOCAL index is (re)written first on every commit (before the head sync, which reads it back), so a resume after a failed local write cannot confirm a record that is not on this device's disk (a failure throws)
		await this.persistManifestLocal({ ...this.manifest, records: [...this.manifest.records] })
		// QA hook builds only (the page's "remote commit fault" switch): one step fails, the way a failed request does
		if (process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && qaFault) {
			if (qaFault === 'timeout') await new Promise((r) => setTimeout(r, this.remoteStepTimeoutMs))
			return qaFault === 'upload' ? 'upload' : 'pointer'
		}
		// new records and resumes alike: first bring the index up to the head. A head that cannot be read or merged: publish NOTHING (an older local list must not replace it)
		if (!this.lockOfAccount()) return 'pointer'
		const headSynced = await this.syncHeadForPublish()
		// a head that was read and already holds the record is the evidence itself (a confirmation that was lost, another tab): nothing is published again for it
		const inHead = [required?.sendId, required?.cid].filter((x): x is string => !!x && this.headKeys.has(x))
		if (inHead.length) {
			const held = (await this.readRemotePending()).filter((p) => this.headKeys.has(p.cid) || (!!p.sendId && this.headKeys.has(p.sendId)))
			await this.notePublished([...held.flatMap((p) => (p.sendId ? [p.sendId, p.cid] : [p.cid])), ...inHead])
			await this.clearRemotePending(held)
			return 'ok'
		}
		if (!headSynced) return 'head_unsynced'
		// ONE snapshot of the index for the whole publication: what is written locally, published and used to clear pending entries is the same list, whatever replaces this.manifest meanwhile
		if (!this.manifest) return 'index_upload'
		const snapshot: IndexManifest = { ...this.manifest, records: [...this.manifest.records] }
		if (!holdsRequired(snapshot.records)) return 'record_missing'
		await this.persistManifestLocal(snapshot)
		const pending = await this.readRemotePending()
		for (const rec of pending) {
			const frag = this.opts.persistence ? ((await this.opts.persistence.get(`${LOCAL_FRAG_KEY_PREFIX}${rec.cid}`)) as string | undefined) : undefined
			if (!frag) return 'no_fragment'
			if (!(await this.uploadFragment(frag))) return 'upload'
		}
		const indexCipher = await aesGcmEncryptString(this.indexKey, JSON.stringify(snapshot))
		const indexHash = await this.uploadFragment(indexCipher)
		if (!indexHash) return 'index_upload'
		if (!(await this.updateOnchainPointer(indexHash, snapshot))) return 'pointer'
		// only the entries the published index holds are done; an entry it does not hold stays pending
		const done = (await this.readRemotePending()).filter((p) => holdsPending(snapshot.records, p))
		await this.notePublished([...done.flatMap((p) => (p.sendId ? [p.sendId, p.cid] : [p.cid])), ...(required?.sendId ? [required.sendId] : []), ...(required?.cid ? [required.cid] : [])])
		await this.clearRemotePending(done)
		return 'ok'
	}
	/** the local index cache of the manifest (the durable local copy), written whatever the remote does */
	private async persistManifestLocal(manifest: IndexManifest | null = this.manifest): Promise<void> {
		if (!manifest || !this.indexKey || !this.opts.persistence) return
		await this.storeVerified(this.localIndexKey(), await aesGcmEncryptString(this.indexKey, JSON.stringify(manifest)))
	}
	/** a duplicate of a record whose remote commit is still pending: retry it now (the mailbox redelivery and the page's retry both come here); throws with the failing step */
	private async finishRemoteIfPending(entry: { dir: 'in' | 'out' }, sid: string, qaFault?: 'upload' | 'pointer' | 'timeout'): Promise<void> {
		if (!this.remoteRequiredFor(entry)) return
		// confirmed only on positive evidence; a record that a pending list does not name is NOT thereby committed
		if (await this.isPublished(sid)) {
			// a published head holds it: its leftover pending entry is done
			const held = (await this.readRemotePending()).filter((p) => p.sendId === sid)
			if (held.length) { await this.notePublished([sid, ...held.map((p) => p.cid)]); await this.clearRemotePending(held) }
			return
		}
		const step = await this.commitRemoteAll(qaFault, { sendId: sid })
		if (step !== 'ok') throw new Error(`remote_commit_failed:${step}`)
	}

	private hasSendId(sendId: string | undefined): boolean {
		if (!sendId || !this.manifest?.records?.length) return false
		return this.manifest.records.some((record) => record.sendId === sendId)
	}

	async append(entry: Omit<HistoryEntry, 'seq'>, opts?: { qaRemoteFault?: 'upload' | 'pointer' | 'timeout' }): Promise<void> {
		// QA hook builds only: the compile-time test is inline, so a product bundle holds neither the option nor the fault branch
		const qaFault = process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true' ? opts?.qaRemoteFault : undefined
		// the encrypted library row first, started at the call and outside the queue behind which an append waits while another one is on the network: a page that ends meanwhile still has the message on this device
		const rowFirst = this.writeRowFirst(entry)
		await this.mutate(async () => {
			await rowFirst
			// D10: an empty sendId is replaced by the deterministic sendKey, written into the index,
			// so the same message mirrored twice is one index record and other devices derive the same key.
			// Without the wallet subkeys K_id is unavailable: the record keeps an empty sendId (no derived dedupe).
			const sid = entry.sendId || (this.localKeys ? await deriveSendKey(this.localKeys.kId, { convKey: entry.peer, dir: entry.dir, sortTs: entry.ts, body: entry.body }) : '')
			// A conversation refresh re-mirrors every local bubble. Those sendIds are
			// already in the in-memory index after the first load — do not pull the
			// on-chain pointer or the IPFS index again for each one.
			// read again under the account lock: another tab may have written the local index
			await this.loadLocalManifest()
			if (sid && this.hasSendId(sid)) {
				await this.ensureLibraryRow(entry, sid)
				await this.finishRemoteIfPending(entry, sid, qaFault)
				return
			}
			const headRead = await this.syncHeadForPublish()
			if (!this.manifest) this.manifest = { v: 1, eoa: this.eoaLower, updatedAt: Date.now(), records: [] }
			const records = this.manifest.records
			if (sid && records.some((record) => record.sendId === sid)) {
				this.emit.log('info', `[history] append skipped existing sendId=${diagnosticCid(sid)}`)
				await this.ensureLibraryRow(entry, sid)
				await this.finishRemoteIfPending(entry, sid, qaFault)
				return
			}
			const seq = records.length ? records[records.length - 1].seq + 1 : 0
			const prevCid = records.length ? records[records.length - 1].cid : this.genesisCid
			const cipher = await aesGcmEncryptString(await this.fragmentKey(seq, prevCid), entry.body)
			const cid = keccakUtf8(cipher)
			if (this.opts.persistence) await this.opts.persistence.set(`${LOCAL_FRAG_KEY_PREFIX}${cid}`, cipher)
			// an inbound record is marked "remote commit pending" (durably) BEFORE any remote step, so a kill at any point leaves a record that the redelivery resumes; its fragment is uploaded by commitRemoteAll
			const needRemote = this.remoteRequiredFor(entry)
			if (needRemote) await this.addRemotePending(cid, sid || undefined)
			else if (!(await this.uploadFragment(cipher)) && this.opts.apiBaseUrl) await this.addRemotePending(cid, sid || undefined) // an outbound fragment that did not upload is pending too: no index naming it is published until it has
			records.push({
				seq,
				cid,
				prevCid,
				ts: entry.ts,
				peer: entry.peer.toLowerCase(),
				dir: entry.dir,
				sendId: sid,
				preview: entry.body.slice(0, 80),
			})
			// the library opens first, so the migration state (applyMigrationState) is known before the plaintext cache is decided. Without this the FIRST append of a worker session wrote one plaintext key
			// (plainCacheEnabled still at its startup default) into an account whose library state is switched / purged. A locked or failing library is not an error here: the cache then keeps its default, as before.
			await this.ensureLocal().catch(() => undefined)
			await this.rememberPlain(cid, {
				seq,
				ts: entry.ts,
				peer: entry.peer.toLowerCase(),
				dir: entry.dir,
				sendId: sid,
				body: entry.body,
			})
			this.manifest.updatedAt = Date.now()
			let remoteStep: RemoteCommitStep = 'ok'
			if (needRemote) {
				// commitRemoteAll writes the local copy first (kept whatever the remote does), then runs the remote commit
				remoteStep = await this.commitRemoteAll(qaFault, { cid, sendId: sid || undefined })
			} else if (headRead || !this.opts.apiBaseUrl) {
				await this.persistManifest()
			} else {
				// outbound, and the head could not be read or merged: keep the local copy, publish nothing, and leave the record pending for the next commit
				await this.persistManifestLocal()
				await this.addRemotePending(cid, sid || undefined)
			}
			const confirmed = await this.ingestLocalAppend({ peer: entry.peer, dir: entry.dir, ts: entry.ts, sendId: sid, body: entry.body }, cid)
			// the index record is written (durable); a library account must also have its row before this append may say "confirmed" (the page's mailbox ACK and the sender's queue release rest on it)
			await this.requireRowOrThrow(confirmed)
			if (sid && confirmed) this.libraryEnsured.add(sid)
			// the local copy and the library row are in place and stay; the append says "confirmed" only when the remote commit succeeded too
			if (remoteStep !== 'ok') throw new Error(`remote_commit_failed:${remoteStep}`)
		})
	}

	/**
	 * The library row of a message being appended, written before any network step. Local only and encrypted (the library's own sealing). It CONFIRMS NOTHING: the append resolves, and so a mailbox ACK or a send
	 * queue release can follow, only under the rules of `append` itself. Best effort: with the library locked, or a write that fails, the append goes on as before. The later write of the same message adds no
	 * second row (it only adds the fragment id). The caller starts it without waiting for the appends queued before it.
	 */
	private async writeRowFirst(entry: Omit<HistoryEntry, 'seq'>): Promise<void> {
		if (!this.localKeys) return
		try {
			await this.init()
			if (!this.localKeys) return
			const sid = entry.sendId || (await deriveSendKey(this.localKeys.kId, { convKey: entry.peer, dir: entry.dir, sortTs: entry.ts, body: entry.body }))
			await this.ingestLocalAppend({ peer: entry.peer, dir: entry.dir, ts: entry.ts, sendId: sid, body: entry.body }, '')
		} catch {
			/* the append's own steps decide and report */
		}
	}

	// ---- Local library -----------------------------------

	private localAccountKey(): string {
		// D5: accountKey = eoa + ":" + workspace; PWA-A uses the default workspace.
		return `${this.eoaLower}:default`
	}

	/**
	 * Subkeys delivered by the wallet layer (condition 2). The worker never derives R_db itself, so the
	 * local library needs no private key here. Null until the wallet layer unlocks.
	 */
	private requireLocalKeys(): { kId: Uint8Array; kIdx: Uint8Array; dek: Uint8Array } {
		if (!this.localKeys) throw new Error('locked')
		return this.localKeys
	}

	/** Receive K_id, K_idx and DEK (hex) from the wallet layer. Replaces any earlier keys and reopens on next use. */
	unlockLocal(keys: { kIdHex: string; kIdxHex: string; dekHex: string }): void {
		this.clearLocalKeys()
		this.localKeys = {
			kId: hexToBytes(keys.kIdHex.replace(/^0x/, '')),
			kIdx: hexToBytes(keys.kIdxHex.replace(/^0x/, '')),
			dek: hexToBytes(keys.dekHex.replace(/^0x/, '')),
		}
		this.localStore?.lock()
		this.localStore = null
		this.localReady = null
	}

	private clearLocalKeys(): void {
		if (this.localKeys) {
			this.localKeys.kId.fill(0)
			this.localKeys.kIdx.fill(0)
			this.localKeys.dek.fill(0)
		}
		this.localKeys = null
	}

	/** The migration state decides the plaintext cache. A non-null state this code does not know keeps the cache ON and is reported (warn), so a new state cannot switch the plaintext cache on silently. */
	private applyMigrationState(migration: string | null | undefined): void {
		this.plainCacheEnabled = plainCacheEnabledFor(migration)
		this.noteLibraryAuthority(migration)
		if (migration !== null && migration !== undefined && !isKnownMigrationState(migration)) {
			this.emit.log('warn', `[local] unknown migration state=${String(migration).replace(/[^a-z0-9_]/g, '').slice(0, 16)}: the legacy plaintext cache stays ON for it`)
		}
	}

	/** the library is the source of truth for this account (migration switched / purged), as read from the library itself in this session */
	private libraryAuthoritative = false

	/** remember the library's authority durably (a value change only), so it still holds when the library cannot be opened in a later session */
	private noteLibraryAuthority(migration: string | null | undefined): void {
		if (migration === null || migration === undefined) return // an unknown read says nothing: keep what is known
		const now = migration === 'switched' || migration === 'purged'
		if (now === this.libraryAuthoritative) return
		this.libraryAuthoritative = now
		const store = this.opts.persistence
		if (store) void store.set(`${LOCAL_LIBAUTH_KEY_PREFIX}${this.eoaLower}`, now ? '1' : '0').catch(() => undefined)
	}

	/** must an append wait for (and fail without) the library row? Yes for a library account: known from this session's library read, or remembered from an earlier session when the library cannot open now. */
	private async libraryMustHoldRow(): Promise<boolean> {
		if (this.libraryAuthoritative) return true
		const store = this.opts.persistence
		if (!store) return false
		try {
			return (await store.get(`${LOCAL_LIBAUTH_KEY_PREFIX}${this.eoaLower}`)) === '1'
		} catch {
			return false
		}
	}

	/** Open the encrypted per-account library. Local only: no network, no sync wait. */
	private async ensureLocal(): Promise<LocalChatStore> {
		if (this.localStore?.status.state === 'open') return this.localStore
		if (!this.localReady) {
			this.localReady = (async () => {
				await this.init()
				const accountKey = this.localAccountKey()
				const dbName = `beamio-chat-local-v1-${(await sha256Hex(utf8(accountKey))).slice(0, 16)}`
				this.localDbNameCache = dbName
				const store = new LocalChatStore(() => openIdbBackend(dbName))
				const r = await store.openWithKeys(this.requireLocalKeys())
				if (r.state !== 'open') this.emit.log('warn', `[local] library locked code=${r.code ?? 'unknown'}`)
				const migration = await store.getMigrationState()
				this.applyMigrationState(migration)
				this.localStore = store
				this.scheduleColdReconcile(migration)
				// a library account (switched / purged) clears its legacy plaintext keys once per worker start, in the background, after the library is open (never blocks the open)
				if (!this.plainPurgeScheduled && (migration === 'switched' || migration === 'purged')) {
					this.plainPurgeScheduled = true
					setTimeout(() => {
						void this.purgeLegacyPlain()
							.then((r) => this.emit.log(r.status === 'blocked' || r.status === 'failed' ? 'warn' : 'info', `[local] legacy plain purge status=${r.status} reason=${r.reason} keys=${r.keys} rows=${r.rows} inserted=${r.inserted} present=${r.present} junk=${r.junk} removed=${r.removed} remaining=${r.remaining}`))
							.catch((ex) => this.emit.log('warn', `[local] legacy plain purge threw: ${(ex as Error)?.message ?? String(ex)}`))
					}, 0)
				}
				return store
			})().catch((ex) => {
				this.localReady = null
				throw ex
			})
		}
		return this.localReady
	}

	/**
	 * a library account whose library holds fewer rows than the index has records (a library row write failed, or the process was killed between the index record and the row) gets one
	 * syncLocal per worker session, in the background, after the library is open. Without it nothing rebuilds the row: a finished earlier sync leaves olderState 'end', so the page's one-time trigger
	 * (olderState 'pending') never fires. Legacy accounts (none / running / complete) keep their library out of the page's read path and are left alone. Counts only; the check reads no row.
	 */
	private scheduleColdReconcile(migration: string | null | undefined): void {
		if (this.coldReconcileScheduled) return
		if (migration !== 'switched' && migration !== 'purged') return
		this.coldReconcileScheduled = true
		this.coldReconcileDone = new Promise<void>((resolve) => setTimeout(resolve, 0))
			.then(() => this.reconcileIfBehind())
			.catch((ex) => this.emit.log('warn', `[local] cold-start reconcile threw: ${(ex as Error)?.message ?? String(ex)}`))
	}

	private async reconcileIfBehind(): Promise<void> {
		const store = this.localStore
		if (!store || store.status.state !== 'open') return
		await this.loadLocalManifest()
		const records = this.manifest?.records?.length ?? 0
		if (records === 0) return
		const rows = await store.countRows()
		if (rows < 0) return // cannot count: say nothing, the page's own triggers stay as they were
		if (rows >= records) {
			this.emit.log('info', `[local] cold-start check: library rows=${rows} index records=${records}: in step`)
			return
		}
		this.emit.log('info', `[local] cold-start check: library rows=${rows} < index records=${records}: running one sync`)
		await this.syncLocal()
	}

	/** Fetch and decrypt one manifest record (plain cache, then cipher, then IPFS). */
	private async incomingFor(rec: IndexRecord): Promise<IncomingRecord | null> {
		const opened = await this.materializeRecord(rec)
		if (!opened.entry) return null
		return incomingFromEntry(opened.entry, rec.cid)
	}

	/**
	 * Full sync into the local library. Runs independently of the first screen.
	 * Records already present with a body are not downloaded.
	 */
	async syncLocal(): Promise<void> {
		const store = await this.ensureLocal()
		await this.loadLocalManifest()
		const records = this.manifest?.records ?? []
		const byCid = new Map(records.map((r) => [r.cid, r] as const))
		const sync: SyncRecord[] = records.map((r) => ({
			convKey: r.peer.toLowerCase(),
			dir: r.dir,
			sortTs: r.ts,
			sendId: r.sendId ?? null,
			cid: r.cid,
		}))
		const stats = await store.syncRecords(sync, async (s) => {
			const rec = byCid.get(s.cid ?? '')
			return rec ? this.incomingFor(rec) : null
		})
		//syncComplete is set only after every index record was processed without failure
		await store.setSyncComplete(stats.failed === 0)
		this.emit.log('info', `[local] sync records=${stats.records} fetched=${stats.fetched} skipped=${stats.skipped} recid=${stats.recid} failed=${stats.failed} sendKeyConflict=${stats.sendKeyConflict} legacyUuid=${stats.legacyUuidFetched}`)
	}

	/** Mirror a newly appended entry into the local library (best effort; the IPFS path is unchanged). */
	private async ingestLocalAppend(entry: { peer: string; dir: 'in' | 'out'; ts: number; sendId?: string; body: string }, cid: string): Promise<boolean> {
		try {
			const store = await this.ensureLocal()
			const outcome = await store.ingest(incomingFromEntry({ seq: 0, ts: entry.ts, peer: entry.peer, dir: entry.dir, sendId: entry.sendId, body: entry.body }, cid))
			if (outcome === 'locked') {
				this.emit.log('warn', '[local] append mirror: library locked, row not written')
				return false
			}
			// every other outcome leaves the library holding this message (inserted, updated, already there, folded, a tombstone that stays terminal) or says it can never hold this copy (conflict, logged by the store's own counters)
			return true
		} catch (ex) {
			this.emit.log('warn', `[local] append mirror failed: ${(ex as Error)?.message ?? String(ex)}`)
			return false
		}
	}

	/** for a library account a missing library row is a FAILED append (the mailbox ACK that follows an append must rest on a readable row); for a legacy account it stays best effort, as before */
	private async requireRowOrThrow(confirmed: boolean): Promise<void> {
		if (!confirmed && (await this.libraryMustHoldRow())) throw new Error('library row not written')
	}

	/**
	 * Migrate PWA-A history into the encrypted library.
	 * running → import (dedupe by stable_id) → digests per conversation → complete with the
	 * verified digest → read-back on a freshly opened library. Any failure keeps the old copies (no deletion).
	 * (rewriting profile and Cache API copies, deleting plain/frag/index keys) is NOT run here; see the receipt.
	 * `extra` carries the profile `chats[].messages` copies from the page.
	 */
	async migrateLocal(extra: Array<{ peer: string; dir: 'in' | 'out'; ts: number; sendId?: string; body: string; pending?: boolean }>): Promise<{ verified: boolean; conversations: number }> {
		const store = await this.ensureLocal()
		if ((await store.getMigrationState()) === 'complete') return { verified: true, conversations: 0 }
		await store.setMigrationState('running')
		await this.loadLocalManifest()
		const records = this.manifest?.records ?? []
		//source rows, deduplicated by stable_id. The manifest copy wins over a profile copy.
		const byStable = new Map<string, IncomingRecord>()
		const addSource = async (inc: IncomingRecord) => {
			const sid = await store.stableIdFor(inc)
			if (!byStable.has(sid)) byStable.set(sid, inc)
		}
		for (const rec of records) {
			const inc = await this.incomingFor(rec)
			if (inc) await addSource(inc)
		}
		const profileOnly: IncomingRecord[] = []
		for (const e of extra) {
			const inc = incomingFromEntry({ seq: 0, ts: e.ts, peer: e.peer, dir: e.dir, sendId: e.sendId, body: e.body }, '')
			inc.pending = !!e.pending
			const sid = await store.stableIdFor(inc)
			if (!byStable.has(sid)) {
				byStable.set(sid, inc)
				profileOnly.push(inc)
			}
		}
		const sources = [...byStable.values()]
		await store.syncRecords(
			records.map((r) => ({ convKey: r.peer.toLowerCase(), dir: r.dir, sortTs: r.ts, sendId: r.sendId ?? null, cid: r.cid })),
			async (s) => {
				const hit = sources.find((x) => x.cid === s.cid)
				return hit ?? null
			},
		)
		for (const inc of profileOnly) await store.ingest(inc)
		//per-conversation digests must match the source rows exactly
		const convs = [...new Set(sources.map((s) => s.convKey))]
		let verified = true
		const parts: string[] = []
		for (const conv of convs) {
			const want = await store.expectedDigest(sources.filter((s) => s.convKey === conv))
			const got = await store.digestConversation(conv)
			parts.push(got.digest)
			if (got.count !== want.count || got.digest !== want.digest) {
				verified = false
				const tag = (await sha256Hex(utf8(conv))).slice(0, 8)
				this.emit.log('error', `[local] import_mismatch conv=${tag} want=${want.count} got=${got.count}`)
			}
		}
		if (!verified) return { verified, conversations: convs.length } // Verification failure: state stays running, nothing deleted
		//complete with the verified digest
		const aggregate = await sha256Hex(utf8(parts.join('|')))
		await store.setMigrationState('complete', aggregate)
		//read-back on a freshly opened library (is the switch to the library)
		const reopened = new LocalChatStore(() => openIdbBackend(this.localDbName()))
		await reopened.openWithKeys(this.requireLocalKeys())
		const rb = await reopened.verifyReadback(100)
		reopened.lock()
		if (rb.failures > 0) {
			await store.setMigrationState('running')
			this.emit.log('error', `[local] readback failed failures=${rb.failures} checked=${rb.checked}`)
			return { verified: false, conversations: convs.length }
		}
		this.plainCacheEnabled = false
		this.emit.log('info', `[local] migration complete conversations=${convs.length} readback=${rb.checked}`)
		return { verified: true, conversations: convs.length }
	}

	/** Current library migration state: none, running, complete, switched or purged. */
	async localMigrationState(): Promise<string> {
		const store = await this.ensureLocal()
		return store.getMigrationState()
	}

	/**from now on the UI reads only from the library. Allowed only after (state complete). */
	async switchLocal(): Promise<boolean> {
		const store = await this.ensureLocal()
		if ((await store.getMigrationState()) !== 'complete') return false
		await store.setMigrationState('switched')
		this.plainCacheEnabled = false // from now on the plaintext cache is neither written nor read
		this.emit.log('info', '[local] migration switched')
		return true
	}

	/**
	 * worker part: delete this account's plaintext `plain:` keys. frag: and index: are ciphertext
	 * and stay. Allowed only after (state switched). Returns the number of keys removed.
	 */
	async purgePlainKeys(): Promise<number> {
		const store = await this.ensureLocal()
		if ((await store.getMigrationState()) !== 'switched') throw new Error('purge requires migration state switched')
		await this.loadLocalManifest()
		const cids = new Set((this.manifest?.records ?? []).map((r) => r.cid))
		let removed = 0
		for (const cid of cids) {
			await this.opts.persistence?.delete(this.plainKey(cid))
			removed++
		}
		// the keys that are NOT in the manifest (the former blind sweep of the whole prefix) now go through the D3 proof: every readable row is ingested into the library and read back before ANY of them is deleted.
		// `purged` is written only when that returns purged or clean (a persistence that cannot list keys has nothing more to sweep: the manifest keys are gone). A blocked or failed sweep keeps the state `switched`
		// and throws, so the caller (the migration) does not mark the account purged; D4 tries again at the next library open.
		const sweep = await this.purgeLegacyPlain()
		const cleared = sweep.status === 'purged' || sweep.status === 'clean' || (sweep.status === 'skipped' && sweep.reason === 'no_keys_api')
		if (!cleared) {
			this.emit.log('warn', `[local] migration purge kept state switched: sweep status=${sweep.status} reason=${sweep.reason} keys=${sweep.keys} junk=${sweep.junk} remaining=${sweep.remaining}`)
			throw new Error(`purge plain keys not complete: ${sweep.status}_${sweep.reason}`)
		}
		removed += sweep.removed
		this.plainCacheEnabled = false
		await store.setMigrationState('purged')
		this.emit.log('info', `[local] migration purged plain keys=${removed}`)
		return removed
	}

	/**
	 * clear this account's legacy plaintext history keys WITHOUT losing history. Applies to `switched` and `purged` library accounts with a persistence that can list keys.
	 * Order: list the keys, read each plaintext row, ingest it into the library (idempotent: a row the library holds is `skipped`), and delete NOTHING unless every row is proven in the library
	 * (no `conflict` / `locked` outcome, no unreadable row, a read-back of the library passes when rows were inserted). Then delete the keys one by one and count again: the number left must be 0.
	 * Only counts are returned and logged. Keys that do not hold a readable plaintext row (nothing recoverable) are removed with the rest.
	 */
	async purgeLegacyPlain(): Promise<PurgeLegacyPlainResult> {
		const out: PurgeLegacyPlainResult = { status: 'skipped', reason: '', keys: 0, rows: 0, inserted: 0, present: 0, junk: 0, removed: 0, remaining: 0 }
		const persistence = this.opts.persistence
		if (!persistence?.keys) return { ...out, reason: 'no_keys_api' }
		const store = await this.ensureLocal()
		const state = await store.getMigrationState()
		if (state !== 'switched' && state !== 'purged') return { ...out, reason: `state_${state}` }
		await this.init()
		const prefix = `${LOCAL_PLAIN_KEY_PREFIX}${this.eoaLower}:`
		let keys: string[]
		try {
			keys = await persistence.keys(prefix)
		} catch {
			return { ...out, status: 'failed', reason: 'keys_failed' }
		}
		out.keys = keys.length
		if (keys.length === 0) {
			this.plainCacheEnabled = false
			return { ...out, status: 'clean' }
		}
		const covered: string[] = []
		const junk: string[] = []
		const added: IncomingRecord[] = []
		for (const key of keys) {
			const value = await persistence.get(key)
			// the key was just listed: no value means the READ failed (the adapter answers undefined on an error), not that the row is empty. Nothing is deleted in that case.
			if (value === undefined) return { ...out, status: 'blocked', reason: 'read_failed' }
			if (!isPlainRecord(value)) {
				junk.push(key)
				continue
			}
			out.rows++
			let outcome: string
			const inc = incomingFromEntry(value.entry, key.slice(prefix.length))
			try {
				outcome = await store.ingest(inc)
			} catch {
				return { ...out, status: 'blocked', reason: 'ingest_threw' }
			}
			if (outcome === 'conflict' || outcome === 'locked') return { ...out, status: 'blocked', reason: `ingest_${outcome}` }
			if (outcome === 'inserted' || outcome === 'updated' || outcome === 'recid' || outcome === 'folded') {
				out.inserted++
				added.push(inc)
			} else out.present++
			covered.push(key)
		}
		out.junk = junk.length
		if (out.inserted > 0) {
			// targeted read-back: every row the library did NOT hold is ingested a second time; the library must now answer `skipped` (same revision, same body hash). Anything else (conflict, locked, a
			// row that is still new) means the row is not proven in the library: NOTHING is deleted.
			for (const inc of added) {
				let again: string
				try {
					again = await store.ingest(inc)
				} catch {
					return { ...out, status: 'blocked', reason: 'readback_threw' }
				}
				if (again !== 'skipped') return { ...out, status: 'blocked', reason: `readback_${again}` }
			}
			// and the random sample over the whole library stays as a second check
			const rb = await store.verifyReadback(100)
			if (rb.failures > 0) return { ...out, status: 'blocked', reason: 'readback_failed' }
		}
		for (const key of [...covered, ...junk]) {
			try {
				await persistence.delete(key)
				out.removed++
			} catch {
				return { ...out, status: 'failed', reason: 'delete_failed', remaining: keys.length - out.removed }
			}
		}
		let left: string[]
		try {
			left = await persistence.keys(prefix)
		} catch {
			return { ...out, status: 'failed', reason: 'recount_failed', remaining: -1 }
		}
		out.remaining = left.length
		if (left.length > 0) return { ...out, status: 'failed', reason: 'remaining' }
		this.plainCacheEnabled = false
		return { ...out, status: 'purged' }
	}

	/**
	 * Logout (D2): lock the library, zero K_id, K_idx and DEK, and drop the open handle. The library file stays.
	 * The protocol master and the sync state are not touched: sign-out must not break protocol history by accident.
	 */
	lockLocal(): void {
		this.localStore?.lock()
		this.localStore = null
		this.localReady = null
		this.clearLocalKeys()
	}

	private localDbName(): string {
		return this.localDbNameCache
	}

	async openConversation(convKey: string, viewport: Viewport): Promise<PageResult> {
		const store = await this.ensureLocal()
		return store.openConversation(convKey.toLowerCase(), viewport)
	}

	async loadOlder(convKey: string, cursor: string, viewport: Viewport): Promise<PageResult> {
		const store = await this.ensureLocal()
		return store.loadOlder(convKey.toLowerCase(), cursor, viewport)
	}

	async reportLayout(convKey: string, stableId: string, viewport: Viewport, wPt: number, hPt: number): Promise<{ written: boolean }> {
		const store = await this.ensureLocal()
		return store.reportLayout(convKey.toLowerCase(), stableId, viewport, wPt, hPt)
	}

	async clearLocalCache(scope: 'conversation' | 'account', convKey?: string): Promise<ClearResult> {
		const store = await this.ensureLocal()
		return store.clearLocalCache(scope, convKey?.toLowerCase())
	}

	destroy(): void {
		this.localStore?.lock()
		this.localStore = null
		this.localReady = null
		// step 3: overwrite key material before releasing it
		this.clearLocalKeys()
		if (this.master) this.master.fill(0)
		if (this.indexKey) this.indexKey.fill(0)
		this.master = null
		this.indexKey = null
		this.manifest = null
		this.corpus.clear()
		this.syncedIndexHash = ''
		this.provider?.destroy?.()
		this.provider = null
		this.ready = false
	}

	// Encoding helpers kept for potential binary fragment mode (unused for now).
	static _b64 = { bytesToBase64, base64ToBytes }
}
