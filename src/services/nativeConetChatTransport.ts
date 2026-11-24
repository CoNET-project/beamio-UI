/**
 * Native-shell adapter for `@conet.project/chat-sdk` full WorkerCommand surface.
 * One transport, two shells: iOS (`chat-sdk-ios`) and Android (`chat-sdk-android`) both
 * implement the same `chatModuleCommand` / `chatModuleEvent` / `chatModuleSignRequest`
 * contract; only the bridge (how a JSON command reaches native and how events come
 * back) differs — see {@link NativeChatBridge}.
 *
 * When Beamio PWA runs inside the iOS WebView shell (`CashTreesIOS` /
 * `webkit.messageHandlers.CashTreesIOS`), Chat UI must **never** spawn the
 * TypeScript gossip Worker — even if `chatModuleCommand` is briefly missing.
 * Native `BeamioConetChatModule` owns OpenPGP, SSE listen, SI POST, and history
 * I/O. The module signs with the wallet key it gets at `init` (kept in
 * Keychain / Keystore). Older modules still emit `chatModuleSignRequest`; this
 * client signs via ethers and replies with `chatModuleSignResponse`.
 *
 * Browser path is unchanged (Worker). Prefer this client for any iOS shell
 * (checked before Android).
 */

import { nextChatTransportReqId } from './reqIdSpaces'
import { qaLine } from '@/utils/qaLog'
import { ethers } from 'ethers'
import { noteBridgeCommand } from '@/utils/qaBridgeCounter'
import { getCachedHelloRaw } from './nativeChatRouteRegister'
import { INBOUND_GENERATION_CAPABILITY, latestInboundGeneration } from './inboundGeneration'
import {
	requestWithInboundGeneration,
	withInboundGeneration,
	type GenerationAttemptAnswer,
	type GenerationOutcome,
} from './inboundGenerationRequest'
import { assertCapabilityPayload, nativeKeysDeclared, publicIdentityFields } from './identityPayload'
import { assertNoKeyOverBridge, IDENTITY_CAPABILITY_MISSING } from './bridgeGuard'
import {
	CHAT_DAEMON_PROTOCOL_VERSION,
	hasCapability,
	negotiateChatDaemon,
	type ChatDaemonCapability,
	type ChatDaemonFeatures,
	type ChatDaemonHello,
	FirstOpenRequest,
	FirstOpenResult,
} from '@conet.project/chat-sdk'
import type {
	BeamioChatClient,
	BeamioChatConfig,
	BeamioChatHistory,
	ChatEventListener,
	ChatEventMap,
	ChatEventName,
	ChatIdentity,
	ChatRoute,
	ChatStatus,
	GroupIssueRosterRequest,
	GroupIssueRosterResult,
	GroupIssueTombstoneRequest,
	GroupIssueTombstoneResult,
	GroupSendRequest,
	GroupSendResult,
	HistoryBufferEvent,
	HistoryEntry,
	HistoryLoadOptions,
	HistoryReadOptions,
	NodeInfo,
	SendMessageOptions,
	Unsubscribe,
} from '@conet.project/chat-sdk'

type ListenerBag<K extends ChatEventName> = Set<ChatEventListener<K>>

type Pending = {
	resolve: (v: unknown) => void
	reject: (e: Error) => void
	timer: ReturnType<typeof setTimeout>
}

const DEFAULT_RUNTIME = {
	sendFanout: 3,
	reconnectBaseMs: 4_000,
	reconnectMaxMs: 30_000,
	outerWrap: true,
} as const

type IosShellWindow = Window & {
	CashTreesIOS?: { chatModuleCommand?: unknown }
	webkit?: { messageHandlers?: { CashTreesIOS?: unknown } }
}

/**
 * True when this page runs inside the CashTrees iOS WebView shell.
 * Any `CashTreesIOS` inject or WK `messageHandlers.CashTreesIOS` means we must
 * **never** spawn the TypeScript gossip Worker.
 */
/** the error of an init that has no node list. It is never sent with an empty list. */
export const NODES_UNAVAILABLE = 'nodes_unavailable'

export function isCashTreesIosShell(): boolean {
	if (typeof window === 'undefined') return false
	const w = window as IosShellWindow
	if (w.CashTreesIOS && typeof w.CashTreesIOS === 'object') return true
	if (w.webkit?.messageHandlers?.CashTreesIOS) return true
	return false
}

/**
 * Prefer native Conet Chat Module for any iOS shell. `chatModuleCommand` is the
 * runtime API; shell presence alone still blocks the TS Worker fallback.
 */
export function preferIosNativeChatClient(): boolean {
	return isCashTreesIosShell()
}

/** How a shell carries `chatModuleCommand` to native and native events back to the PWA. */
export type NativeChatBridge = {
	/** Log label, e.g. `ios native chat`. */
	label: string
	/** `window` CustomEvent name that carries native payloads in `detail`. */
	eventName: string
	/** Deliver a WorkerCommand to the native module. Throws when the bridge is absent. */
	postCommand(cmd: Record<string, unknown>): void
	/** Deliver a sign result for a `chatModuleSignRequest`. */
	signResponse(payload: { reqId: string | number; ok: boolean; signature?: string; error?: string }): void
	/**
	 * chat-sdk-ios ≤ 0.1.4 history surface (see `NativeHistoryBridge`). Used only
	 * when the module does not answer `hello` (modules before protocol v1).
	 */
	legacyHistory?: boolean
}

/**
 * Modules from protocol v1 answer `hello`; older ones never do. `init` waits for that answer, up to this limit. Before this change the
 * wait was a fixed 150 ms window (HELLO_SETTLE_MS), so a real S25 (hello round trip 424 to 478 ms) read a declared capability as missing
 * Now a declared capability is read when its answer arrives. The cost is only the start-up delay of an old shell that never
 * answers hello: that shell is decided after this limit instead of after 150 ms.
 *
 * 2026-11-24 (late is not dead): the limit is the 180 s cold-start window, not 5 s. A hello that has not answered yet is not a missing
 * capability, so the init waits for it (the slowest seen was 39 s on a cold S25). The page's shared hello answer is used when it is already there.
 */
const HELLO_TIMEOUT_MS = 180_000

const LEGACY_FEATURES: ChatDaemonFeatures = negotiateChatDaemon(null)

const IOS_NATIVE_CHAT_BRIDGE: NativeChatBridge = {
	label: 'ios native chat',
	eventName: 'cashtreesios',
	legacyHistory: true,
	postCommand(cmd) {
		noteBridgeCommand('chatModule', cmd.type)
		const ios = (window as Window & {
			CashTreesIOS?: { chatModuleCommand?: (p: Record<string, unknown>) => void }
		}).CashTreesIOS
		if (typeof ios?.chatModuleCommand !== 'function') {
			throw new Error('CashTreesIOS.chatModuleCommand unavailable')
		}
		ios.chatModuleCommand({ action: 'chatModuleCommand', command: cmd })
	},
	signResponse(payload) {
		const ios = (window as Window & {
			CashTreesIOS?: { chatModuleSignResponse?: (p: typeof payload) => void }
		}).CashTreesIOS
		if (typeof ios?.chatModuleSignResponse !== 'function') {
			throw new Error('chatModuleSignResponse unavailable')
		}
		ios.chatModuleSignResponse(payload)
	},
}

/** How long load/append wait for the native history key (two PWA signatures) before trying anyway. */
const HISTORY_READY_WAIT_MS = 90_000
/** A native restore downloads every fragment; iOS 0.1.4 does it one by one. */
const HISTORY_LOAD_TIMEOUT_MS = 300_000
/** An append uploads a fragment + the index, then relays the head pointer. */
const HISTORY_APPEND_TIMEOUT_MS = 120_000
/** iOS 0.1.4 answers a load with only `tailCount` entries: ask for all of them. */
const LEGACY_HISTORY_LOAD_ALL = 1_000_000
const LEGACY_APPEND_QUEUE_MAX = 500
const LEGACY_LOAD_RETRY_MS = 30_000
const LEGACY_LOAD_RETRY_MAX = 10
/** The native history sync answers `sync_failed` when its local store is closed or locked, a fetch failed or only part arrived: retryable, bounded. */
const SYNC_FAILED_CODE = 'sync_failed'
const SYNC_FAILED_RETRY_MS = 30_000
const SYNC_FAILED_RETRY_MAX = 10

const REGISTRY_GET_POINTER_ABI = [
	'function getPointer(address) view returns (bytes32 indexHash,uint64 ts,uint64 seq,uint64 updatedAt)',
]

const historyEntryKey = (e: HistoryEntry): string =>
	e.sendId ? `send:${e.sendId}` : `seq:${e.seq}|${e.ts}|${e.peer}`

/** iOS 0.1.4 answers `{ entries }`; Android and the TS worker answer the array itself. */
function normalizeHistoryEntries(result: unknown): HistoryEntry[] | null {
	const raw = Array.isArray(result)
		? result
		: result && typeof result === 'object' && Array.isArray((result as { entries?: unknown }).entries)
			? (result as { entries: unknown[] }).entries
			: null
	if (!raw) return null
	const out: HistoryEntry[] = []
	for (const row of raw) {
		if (!row || typeof row !== 'object') continue
		const r = row as Record<string, unknown>
		const body = typeof r.body === 'string' ? r.body : ''
		const peer = String(r.peer || '').toLowerCase()
		if (!body || !peer) continue
		out.push({
			seq: Number(r.seq) || 0,
			ts: Number(r.ts) || 0,
			peer,
			dir: r.dir === 'out' ? 'out' : 'in',
			sendId: r.sendId != null && String(r.sendId) ? String(r.sendId) : undefined,
			body,
		})
	}
	return out
}

/**
 * History over the native module (`historyLoad` / `historyAppend` / `historyRead`).
 *
 * Both native modules derive the history key from two PWA signatures. Android does that
 * after `init` resolves, so a load or append sent right after init finds no key and is
 * dropped. Every call here first waits for the module's `[history] ready` log.
 *
 * `legacy` (chat-sdk-ios ≤ 0.1.4, whose init does not report `historyApi: 2`) also needs:
 *  - load/read answer `{ entries }` once and never stream `historyBuffer`: emit the answer.
 *  - read re-downloads every fragment: answer from the entries the last load returned.
 *  - append has no sendId dedup, and an append before the first load starts the chain over
 *    at seq 0 and replaces the head pointer: hold appends until a trusted load finished.
 *  - every load rewrites the head pointer with the same records: decline that signature.
 */
class NativeHistoryBridge implements BeamioChatHistory {
	private bufferListeners = new Set<(batch: HistoryBufferEvent) => void>()
	private readyState: 'pending' | 'ready' | 'failed' = 'pending'
	private readyWaiters = new Set<() => void>()
	private loadsInFlight = new Map<string, Promise<void>>()
	private legacyLoads = 0
	private legacySynced = false
	private legacyRetries = 0
	private legacyRetryTimer: ReturnType<typeof setTimeout> | null = null
	private syncFailedRetries = 0
	private syncFailedTimer: ReturnType<typeof setTimeout> | null = null
	private corpus = new Map<string, HistoryEntry>()
	private appendQueue: Array<{ entry: Omit<HistoryEntry, 'seq'>; done: () => void }> = []
	/** Legacy loads and appends run one at a time, so a load's pointer rewrite is told apart. */
	private lane: Promise<unknown> = Promise.resolve()

	private legacy: boolean

	constructor(
		private readonly client: NativeConetChatClientImpl,
		private readonly legacyShell: boolean,
	) {
		this.legacy = legacyShell
	}

	/**
	 * After `init`. A module that answered `hello` decides by `history.v2`. An
	 * older one: iOS shells are legacy unless `init` reported `historyApi >= 2`.
	 */
	_setHistoryFeatures(features: ChatDaemonFeatures, api: number): void {
		this.legacy =
			features.status === 'negotiated'
				? !hasCapability(features, 'history.v2')
				: this.legacyShell && !(api >= 2)
	}

	/** True while a legacy load runs: its head-pointer rewrite is redundant. */
	get legacyLoadInFlight(): boolean {
		return this.legacy && this.legacyLoads > 0
	}

	/** Native log line → history key readiness. */
	_noteLog(message: string): void {
		if (/\[history\] ready\b/.test(message)) this.setReady('ready')
		else if (/\[history\] (prepare failed|domain sign failed|selfSign failed|keccak master failed|hkdf failed)/.test(message)) {
			this.setReady('failed')
		}
	}

	/** A new native session (init) derives the key again. */
	_resetSession(): void {
		this.readyState = 'pending'
		this.legacySynced = false
		this.legacyRetries = 0
		this.syncFailedRetries = 0
		this.clearRetry()
	}

	_destroy(): void {
		this.clearRetry()
		this.setReady('failed')
		for (const item of this.appendQueue.splice(0)) item.done()
	}

	private setReady(state: 'ready' | 'failed'): void {
		this.readyState = state
		for (const wake of [...this.readyWaiters]) wake()
		this.readyWaiters.clear()
		if (state === 'ready') this.client.log('info', '[chatHistory] native history key ready')
	}

	private waitReady(): Promise<boolean> {
		if (this.readyState !== 'pending') return Promise.resolve(this.readyState === 'ready')
		return new Promise<boolean>((resolve) => {
			const wake = () => {
				clearTimeout(timer)
				this.readyWaiters.delete(wake)
				resolve(this.readyState === 'ready')
			}
			const timer = setTimeout(() => {
				this.readyWaiters.delete(wake)
				this.client.log('warn', '[chatHistory] native history key not confirmed — trying anyway')
				resolve(false)
			}, HISTORY_READY_WAIT_MS)
			this.readyWaiters.add(wake)
		})
	}

	private inLane<T>(task: () => Promise<T>): Promise<T> {
		const run = this.lane.catch(() => undefined).then(task)
		this.lane = run.catch(() => undefined)
		return run
	}

	private clearRetry(): void {
		if (this.legacyRetryTimer) clearTimeout(this.legacyRetryTimer)
		this.legacyRetryTimer = null
		if (this.syncFailedTimer) clearTimeout(this.syncFailedTimer)
		this.syncFailedTimer = null
	}

	load(options?: HistoryLoadOptions): Promise<void> {
		const key = JSON.stringify(options ?? {})
		const running = this.loadsInFlight.get(key)
		if (running) return running
		const run = this.waitReady()
			.then(() => (this.legacy ? this.loadLegacy(options) : this.loadNative(options)))
			.finally(() => {
				if (this.loadsInFlight.get(key) === run) this.loadsInFlight.delete(key)
			})
		this.loadsInFlight.set(key, run)
		return run
	}

	private async loadNative(options?: HistoryLoadOptions): Promise<void> {
		this.client.log('info', '[chatHistory] native history.load → on-chain pointer / IPFS index')
		try {
			await this.client.request<void>({ type: 'historyLoad', reqId: 0, options }, HISTORY_LOAD_TIMEOUT_MS)
			this.syncFailedRetries = 0
		} catch (ex) {
			// sync_failed (syncState=error) is retryable: never "synced" and never "no history". The load still rejects (the caller logs it);
			// the next load is scheduled here, bounded. Any other failure is unchanged.
			if ((ex as Error)?.message === SYNC_FAILED_CODE) this.scheduleSyncFailedRetry(options)
			throw ex
		}
	}

	private scheduleSyncFailedRetry(options?: HistoryLoadOptions): void {
		if (this.syncFailedRetries >= SYNC_FAILED_RETRY_MAX || this.syncFailedTimer) return
		this.syncFailedRetries += 1
		this.client.log('warn', `[chatHistory] native history sync_failed (retryable) — retry ${this.syncFailedRetries} in ${SYNC_FAILED_RETRY_MS / 1000}s`)
		this.syncFailedTimer = setTimeout(() => {
			this.syncFailedTimer = null
			void this.load(options).catch(() => undefined)
		}, SYNC_FAILED_RETRY_MS)
	}

	private async loadLegacy(options?: HistoryLoadOptions): Promise<void> {
		const fullLoad = !options?.peer
		const entries = await this.inLane(async (): Promise<HistoryEntry[] | null> => {
			this.legacyLoads += 1
			try {
				this.client.log('info', '[chatHistory] native history.load (iOS 0.1.4) → on-chain pointer / IPFS index')
				const result = await this.client.request<unknown>(
					{
						type: 'historyLoad',
						reqId: 0,
						options: { ...(options ?? {}), tailCount: options?.tailCount ?? LEGACY_HISTORY_LOAD_ALL },
					},
					HISTORY_LOAD_TIMEOUT_MS,
				)
				return normalizeHistoryEntries(result)
			} catch (ex) {
				this.client.log('warn', `[chatHistory] native history.load failed: ${(ex as Error)?.message ?? String(ex)}`)
				return null
			} finally {
				this.legacyLoads -= 1
			}
		})
		if (entries) {
			for (const e of entries) this.corpus.set(historyEntryKey(e), e)
			this.client.log('info', `[chatHistory] native history decrypted ${entries.length}`)
			if (entries.length) {
				this._emit({ peer: options?.peer?.toLowerCase() || 'all', entries, isTail: true })
			}
		}
		if (fullLoad && !this.legacySynced) await this.settleLegacySync(entries)
	}

	/**
	 * Release held appends only after the native index matches the chain: the load returned
	 * records, or the chain has no pointer yet (first message of this account). Otherwise
	 * an append would publish an index that drops every earlier record.
	 */
	private async settleLegacySync(entries: HistoryEntry[] | null): Promise<void> {
		let trusted = !!entries && entries.length > 0
		if (!trusted && entries) trusted = (await this.client.readPointerSeq()) === 0
		if (trusted) {
			this.legacySynced = true
			this.clearRetry()
			this.flushAppendQueue()
			return
		}
		if (this.legacyRetries >= LEGACY_LOAD_RETRY_MAX || this.legacyRetryTimer) return
		this.legacyRetries += 1
		this.client.log('warn', `[chatHistory] native index not synced with the chain — retry ${this.legacyRetries} in ${LEGACY_LOAD_RETRY_MS / 1000}s`)
		this.legacyRetryTimer = setTimeout(() => {
			this.legacyRetryTimer = null
			void this.load().catch(() => undefined)
		}, LEGACY_LOAD_RETRY_MS)
	}

	async append(entry: Omit<HistoryEntry, 'seq'>): Promise<void> {
		await this.waitReady()
		if (!this.legacy) {
			await this.client.request<void>({ type: 'historyAppend', reqId: 0, entry }, HISTORY_APPEND_TIMEOUT_MS)
			return
		}
		if (entry.sendId && this.corpus.has(`send:${entry.sendId}`)) return Promise.resolve()
		return new Promise<void>((resolve) => {
			if (this.appendQueue.length >= LEGACY_APPEND_QUEUE_MAX) this.appendQueue.shift()?.done()
			this.appendQueue.push({ entry, done: resolve })
			if (this.legacySynced) this.flushAppendQueue()
			else if (!this.loadsInFlight.size && !this.legacyRetryTimer) void this.load().catch(() => undefined)
		})
	}

	/** One append at a time; skip sendIds the index already holds. */
	private flushAppendQueue(): void {
		for (const item of this.appendQueue.splice(0)) {
			void this.inLane(async () => {
				const { entry } = item
				try {
					if (entry.sendId && this.corpus.has(`send:${entry.sendId}`)) return
					await this.client.request<unknown>({ type: 'historyAppend', reqId: 0, entry }, HISTORY_APPEND_TIMEOUT_MS)
					const stored: HistoryEntry = { ...entry, peer: entry.peer.toLowerCase(), seq: this.corpus.size }
					this.corpus.set(historyEntryKey(stored), stored)
				} catch (ex) {
					this.client.log('warn', `[chatHistory] native history.append failed: ${(ex as Error)?.message ?? String(ex)}`)
				} finally {
					item.done()
				}
			})
		}
	}

	async read(options?: HistoryReadOptions): Promise<HistoryEntry[]> {
		await this.waitReady()
		if (!this.legacy) {
			const result = await this.client.request<unknown>({ type: 'historyRead', reqId: 0, options }, 60_000)
			return normalizeHistoryEntries(result) ?? []
		}
		const pending = [...this.loadsInFlight.values()]
		if (pending.length) await Promise.allSettled(pending)
		const peer = options?.peer?.toLowerCase()
		const terms = (options?.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
		const entries = [...this.corpus.values()].filter((e) => {
			if (peer && e.peer !== peer) return false
			if (!terms.length) return true
			const text = e.body.toLowerCase()
			return terms.every((t) => text.includes(t))
		})
		entries.sort((a, b) => a.ts - b.ts || a.seq - b.seq)
		const limit = options?.limit
		return limit && limit > 0 ? entries.slice(-limit) : entries
	}

	onBuffer(cb: (batch: HistoryBufferEvent) => void): Unsubscribe {
		this.bufferListeners.add(cb)
		return () => this.bufferListeners.delete(cb)
	}

	// Local library has no native port yet: callers fall back to the legacy path.
	async openConversation(): Promise<never> {
		throw new Error('local chat library unavailable on this client')
	}

	async loadOlder(): Promise<never> {
		throw new Error('local chat library unavailable on this client')
	}

	async reportLayout(): Promise<never> {
		throw new Error('local chat library unavailable on this client')
	}

	async clearLocalCache(): Promise<never> {
		throw new Error('local chat library unavailable on this client')
	}

	async syncLocal(): Promise<never> {
		throw new Error('local chat library unavailable on this client')
	}

	async migrateLocal(): Promise<never> {
		throw new Error('local chat library unavailable on this client')
	}

	async migrationState(): Promise<never> {
		throw new Error('local chat library unavailable on this client')
	}

	async switchLocal(): Promise<never> {
		throw new Error('local chat library unavailable on this client')
	}

	async purgeLocalPlain(): Promise<never> {
		throw new Error('local chat library unavailable on this client')
	}

	async lockLocal(): Promise<never> {
		throw new Error('local chat library unavailable on this client')
	}

	async unlockLocal(): Promise<never> {
		throw new Error('local chat library unavailable on this client')
	}

	_emit(batch: HistoryBufferEvent): void {
		for (const cb of this.bufferListeners) {
			try {
				cb(batch)
			} catch {
				/* isolate */
			}
		}
	}
}

class NativeConetChatClientImpl implements BeamioChatClient {
	private pending = new Map<number, Pending>()
	private listeners: { [K in ChatEventName]?: ListenerBag<K> } = {}
	private historyBridge: NativeHistoryBridge
	private routes: ChatRoute[] = []
	private nodes: NodeInfo[] = []
	private destroyed = false
	private nativeListener: ((ev: Event) => void) | null = null
	private features: ChatDaemonFeatures = LEGACY_FEATURES
	private helloAnswer: Promise<ChatDaemonHello | null> = Promise.resolve(null)
	/** The `hello` answer as received, when the module negotiated. Unknown capability names are kept here (identityPayload.ts). */
	private helloRaw: unknown = null
	/** The capability names the hello answer offers, as sent (the SDK's negotiated list keeps only the names it knows). */
	private helloOffered: readonly string[] = []

	constructor(
		private readonly config: NativeChatConfig,
		private readonly bridge: NativeChatBridge,
	) {
		this.historyBridge = new NativeHistoryBridge(this, bridge.legacyHistory === true)
	}

	get history(): BeamioChatHistory {
		return this.historyBridge
	}

	/** Protocol v1 `hello` answer of the native module; null for modules before v1. */
	hello(): Promise<ChatDaemonHello | null> {
		return this.helloAnswer
	}

	/** What the native module negotiated (`legacy` until / unless it answers `hello`). */
	get daemonFeatures(): ChatDaemonFeatures {
		return this.features
	}

	/** True when the module negotiated `cap`, or did not answer `hello` (keep the pre-v1 behaviour). */
	private allows(cap: ChatDaemonCapability): boolean {
		return this.features.status !== 'negotiated' || hasCapability(this.features, cap)
	}

	private startHello(): Promise<ChatDaemonHello | null> {
		const shared = getCachedHelloRaw()
		const ask: Promise<unknown> =
			shared !== undefined
				? Promise.resolve(shared)
				: this.request<unknown>({ type: 'hello', reqId: 0, protocolVersion: CHAT_DAEMON_PROTOCOL_VERSION }, HELLO_TIMEOUT_MS)
		const answer = ask
			.then((result) => {
				const features = negotiateChatDaemon(result)
				this.features = features
				const offered = (result as { capabilities?: unknown } | null)?.capabilities
				this.helloOffered = Array.isArray(offered) ? offered.filter((c): c is string => typeof c === 'string') : []
				if (process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true') qaLine('[send]', `hello caps=${this.helloOffered.length} gen=${this.helloOffered.includes(INBOUND_GENERATION_CAPABILITY) ? 1 : 0} deferAck=${this.helloOffered.includes('inbound.deferAck') ? 1 : 0}`)
				if (features.status === 'negotiated') {
					this.helloRaw = result
					this.log(
						'info',
						`${this.bridge.label}: protocol v${features.protocolVersion} sdk ${features.sdkVersion || '?'} caps=${features.capabilities.join(',')}`,
					)
					return result as ChatDaemonHello
				}
				this.log('warn', `${this.bridge.label}: hello answer not usable (${features.status})`)
				return null
			})
			.catch(() => {
				if (!this.destroyed) this.log('info', `${this.bridge.label}: no hello answer (module before protocol v1)`)
				return null
			})
		this.helloAnswer = answer
		return answer
	}

	async init(): Promise<void> {
		return this.runInit(false)
	}

	/**
	 * `identityOnly` (G1 start): init with the EOA only (the native layer checks it). No
	 * provisionIdentity follows; the listen is not started by this path.
	 */
	async runInit(identityOnly: boolean): Promise<void> {
		if (this.destroyed) throw new Error('native chat client destroyed')
		this.historyBridge._resetSession()
		this.attachNativeListener()
		this.features = LEGACY_FEATURES
		this.helloRaw = null
		const hello = this.startHello()
		let readNodes: NodeInfo[] | null = null
		try {
			readNodes = await this.config.getNodes()
		} catch {
			readNodes = null
		}
		// decide only after the hello answer has arrived, or after the 180 s window with no answer (null).
		await hello
		// The init is never sent with an empty list . A full init needs a node list and fails without one. An identity-only
		// init (G1) omits the `nodes` key when no list is available: the native layer keeps the nodes it has stored.
		const haveNodes = !!readNodes && readNodes.length > 0
		if (!haveNodes && !identityOnly) {
			this.log('error', `${this.bridge.label}: node list unavailable: not started`)
			throw new Error(NODES_UNAVAILABLE)
		}
		if (!haveNodes) this.log('warn', `${this.bridge.label}: identity-only init without a node list (the native layer keeps its stored nodes)`)
		this.nodes = haveNodes ? (readNodes as NodeInfo[]) : []
		this.routes = []
			// identity.native-keys.v1: the wallet key never crosses the bridge. A module that does not declare the
			// capability is not started: nothing is sent, and the caller shows the locked or prompt state (no fallback).
			if (!nativeKeysDeclared(this.features, this.helloRaw)) {
				this.log('warn', `${this.bridge.label}: identity.native-keys.v1 not declared; native chat not started`)
				throw new Error(IDENTITY_CAPABILITY_MISSING)
			}
			// The identity object is under `identity` and carries public fields only.
			const payload = {
				identity: publicIdentityFields(this.config.identity),
			conetRpcUrl: this.config.conetRpcUrl,
			addressPgpContractAddress: this.config.addressPgpContractAddress,
			ipfsBaseUrl: this.config.ipfsBaseUrl,
			ipfsWriteBaseUrl: this.config.ipfsWriteBaseUrl,
			chainId: this.config.chainId ?? 224422,
			chatIndexRegistryAddress:
				this.config.chatIndexRegistryAddress ?? '0x1511Caa71081C84d8a591490D1b83879088EED72',
			apiBaseUrl: this.config.apiBaseUrl,
			runtime: { ...DEFAULT_RUNTIME, ...(this.config.runtime ?? {}) },
			...(haveNodes ? { nodes: this.nodes } : {}),
			routes: this.routes,
			// Written only when the hello declares `inbound.deferAck`: a shell that does not declare it gets no field.
			// `deferAck: true` (capability `inbound.deferAck`): this page calls `ackInbound` after it has stored or shown each
			// message. The native module reads `true` as a new page; `false` or a missing field is an old page. The module sends
			// the mailbox ACK itself at store time and keeps the armor until `ackInbound`. The old meaning (the module holds the mailbox
			// ACK until `ackInbound`) is withdrawn. Older SDKs ignore the field.
			...(this.helloOffered.includes('inbound.deferAck') ? { deferAck: true } : {}),
		}
			assertCapabilityPayload(payload, 'init')
		const ready = await this.request<{ historyApi?: unknown } | undefined>({ type: 'init', reqId: 0, payload }, 180_000)
		// `identity.provision`: the native daemon stores the public fields only; its key is already in Keychain / Keystore. It is
		// sent after init succeeds: in G1 (key present, not yet init) the shell refuses provisionIdentity with not_ready (spec
		// gate-state), so it can only be accepted once the session is ready (G2)..
		if (!identityOnly && this.allows('identity.provision')) {
			const provisionPayload = { ...publicIdentityFields(this.config.identity), nodes: this.nodes }
			assertCapabilityPayload(provisionPayload, 'provisionIdentity')
			// A real request with a valid reqId (the SDK refuses a negative one at the entry, bad_request with a null reqId): the answer is read, not dropped.
			this.request<unknown>({ type: 'provisionIdentity', payload: provisionPayload }, 30_000).then(
				() => this.log('info', `${this.bridge.label}: provisionIdentity accepted`),
				(e: unknown) => this.log('warn', `${this.bridge.label}: provisionIdentity refused (${String((e as Error)?.message || 'unknown').slice(0, 40)})`),
			)
		}
		this.historyBridge._setHistoryFeatures(
			this.features,
			Number(ready && typeof ready === 'object' ? ready.historyApi : 0) || 0,
		)
	}

	/** Diagnostics into the host log sink (no key material / plaintext). */
	log(level: 'info' | 'warn' | 'error', message: string): void {
		this.emit('log', { level, message })
	}

	/** On-chain history head `seq` (RPC `getPointer`); 0 = no pointer yet, null = unreadable. */
	async readPointerSeq(): Promise<number | null> {
		const owner = this.config.identity.eoaAddress
		const registry = this.config.chatIndexRegistryAddress ?? '0x1511Caa71081C84d8a591490D1b83879088EED72'
		if (!owner || !this.config.conetRpcUrl) return null
		const net = new ethers.Network('conet', this.config.chainId ?? 224422)
		const provider = new ethers.JsonRpcProvider(this.config.conetRpcUrl, net, { staticNetwork: net })
		try {
			const contract = new ethers.Contract(registry, REGISTRY_GET_POINTER_ABI, provider)
			const ptr = await contract.getPointer(owner)
			if (!ptr?.[0] || /^0x0+$/.test(String(ptr[0]))) return 0
			return Number(ptr[2])
		} catch {
			return null
		} finally {
			provider.destroy()
		}
	}

	/**
	 * The page calls this after it has stored or shown the inbound messages. It cleans the native inbox armor and
	 * sends the sender receipt. It does not trigger the mailbox ACK, which the module sends at store time.
	 */
	ackInbound(armorHashes: string[]): void {
		const hashes = (armorHashes || []).filter((h) => typeof h === 'string' && h.length > 0)
		if (!hashes.length || this.destroyed || !this.allows('inbound.deferAck')) return
		this.postNoReply({ type: 'ackInbound', armorHashes: hashes })
	}

	/**
	 * The contact routes for the native receipt path: the WHOLE table (the native side replaces its table), with the page's own account EOA
	 * (the native side ignores a table whose EOA is not its session's). Memory only on the native side; the init payload keeps routes [].
	 */
	setRoutes(routes: ChatRoute[]): void {
		if (this.destroyed) return
		const eoa = String(this.config.identity.eoaAddress || '').trim().toLowerCase()
		if (!eoa) return
		const list = (routes || [])
			.filter((r) => r && r.address && r.userPublicKeyArmored && r.routerArmoredPublicKey)
			.map((r) => ({ eoaAddress: String(r.address).toLowerCase(), userPublicKeyArmored: r.userPublicKeyArmored, routerArmoredPublicKey: r.routerArmoredPublicKey }))
		this.postNoReply({ type: 'setRoutes', eoa, routes: list })
		if (process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true') qaLine('[send]', `routes set n=${list.length} own=${eoa.slice(0, 8)} first=${list.slice(0, 3).map((r) => r.eoaAddress.slice(0, 8)).join(',')}`)
	}

	setNodes(nodes: NodeInfo[]): void {
		if (!nodes?.length) return
		this.nodes = nodes
		this.postNoReply({ type: 'setNodes', nodes })
	}

	async sendGroupMessage(request: GroupSendRequest): Promise<GroupSendResult> {
		const out = await this.requestWithGeneration((g) => withInboundGeneration({ type: 'sendGroup', request }, g), 60_000)
		if (!out.ok) throw new Error(out.reason)
		return out.result as GroupSendResult
	}

	async issueGroupRoster(request: GroupIssueRosterRequest): Promise<GroupIssueRosterResult> {
		const out = await this.requestWithGeneration((g) => withInboundGeneration({ type: 'issueGroupRoster', request }, g), 60_000)
		if (!out.ok) throw new Error(out.reason)
		return out.result as GroupIssueRosterResult
	}

	async issueGroupTombstone(request: GroupIssueTombstoneRequest): Promise<GroupIssueTombstoneResult> {
		const out = await this.requestWithGeneration((g) => withInboundGeneration({ type: 'issueGroupTombstone', request }, g), 60_000)
		if (!out.ok) throw new Error(out.reason)
		return out.result as GroupIssueTombstoneResult
	}

	async sendMessage(to: ChatRoute, payload: string, opts?: SendMessageOptions): Promise<{ sendId: string }> {
		const sendId = opts?.sendId || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
		// The same sendId on every attempt: the native layer de-duplicates by it.
		const out = await this.requestWithGeneration(
			(g) => {
				if (process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true') qaLine('[send]', `gen has=${g === undefined ? 0 : 1} value=${typeof g === 'number' ? g : 'none'}`)
				return withInboundGeneration({ type: 'send', to, payload, sendId, beamioNoPush: opts?.beamioNoPush }, g)
			},
			60_000,
		)
		if (!out.ok) throw new Error(out.reason)
		const result = out.result as { sent?: unknown } | null
		// The module acks ok with `sent: false` when every entry failed.
		if (result && typeof result === 'object' && result.sent === false) {
			throw new Error('native send: not delivered to any entry')
		}
		return { sendId }
	}

	async queryPresence(contacts: ChatRoute[]): Promise<Record<string, boolean>> {
		const result = await this.request<Record<string, boolean>>(
			{ type: 'queryPresence', reqId: 0, contacts },
			30_000,
		)
		return result && typeof result === 'object' ? result : {}
	}

	/** The automatic first open is browser-only: the shell keeps its native keys and never runs it here. */
	async firstOpen(_request: FirstOpenRequest): Promise<FirstOpenResult> {
		return { status: 'error', reason: 'unsupported' }
	}

	async queryNativeWake(contact: ChatRoute): Promise<boolean | null> {
		try {
			const result = await this.request<{ nativeWakeable?: boolean; ok?: boolean }>(
				{ type: 'queryNativeWake', reqId: 0, contact },
				30_000,
			)
			if (!result || typeof result !== 'object') return null
			if (result.ok === false) return null
			return typeof result.nativeWakeable === 'boolean' ? result.nativeWakeable : null
		} catch {
			return null
		}
	}

	async postMailboxCommand(
		routerArmoredPublicKey: string,
		command: Record<string, unknown>,
	): Promise<boolean> {
		try {
			const out = await this.requestWithGeneration(
				(g) => withInboundGeneration({ type: 'mailboxCommand', routerArmoredPublicKey, command }, g),
				30_000,
			)
			return out.ok
		} catch {
			return false
		}
	}

	async postOwnMailboxCommand(command: Record<string, unknown>): Promise<boolean> {
		try {
			const out = await this.requestWithGeneration((g) => withInboundGeneration({ type: 'ownMailboxCommand', command }, g), 30_000)
			return out.ok
		} catch {
			return false
		}
	}

	async startVoiceListen(sessionId: string, _call?: unknown): Promise<boolean> {
		// The shell's native voice module owns v3 channels; call keys never cross this bridge.
		try {
			await this.request<void>({ type: 'voiceListen', reqId: 0, sessionId }, 60_000)
			return true
		} catch {
			return false
		}
	}

	async stopVoiceListen(sessionId: string): Promise<boolean> {
		try {
			await this.request<void>({ type: 'voiceUnlisten', reqId: 0, sessionId }, 30_000)
			return true
		} catch {
			return false
		}
	}

	async sendVoiceFrame(routerArmoredPublicKey: string, frame: Record<string, unknown>): Promise<boolean> {
		try {
			await this.request<void>({ type: 'voiceFrame', reqId: 0, routerArmoredPublicKey, frame }, 30_000)
			return true
		} catch {
			return false
		}
	}

	pause(): void {
		this.postNoReply({ type: 'pause' })
	}

	resume(): void {
		this.postNoReply({ type: 'resume' })
	}

	/**
	 * Normal stop, restart and foreground resume: releases this client's listeners and local state only, and
	 * sends nothing to the native layer. A bare destroy has no reqId and is answered bad_request, so it did nothing anyway. The
	 * global teardown is sent by the logout and lock path alone (nativeKeyState.sendGlobalDestroyOnLogout).
	 */
	destroy(): void {
		if (this.destroyed) return
		this.teardownLocal()
	}

	/**
	 * Local teardown only: detaches the page listeners and sends nothing to the native layer. The identity-only init uses this,
	 * so no unscoped `destroy` (no reqId) can reach a running native chat (Android S25 observation, 2026-11-13).
	 */
	teardownLocal(): void {
		this.destroyed = true
		this.detachNativeListener()
		this.historyBridge._destroy()
		this.rejectPending(new Error('native chat destroyed'))
		for (const k of Object.keys(this.listeners) as ChatEventName[]) {
			this.listeners[k]?.clear()
		}
	}

	on<K extends ChatEventName>(event: K, cb: ChatEventListener<K>): Unsubscribe {
		let set = this.listeners[event] as ListenerBag<K> | undefined
		if (!set) {
			set = new Set()
			;(this.listeners as Record<string, Set<ChatEventListener<ChatEventName>>>)[event] = set as Set<
				ChatEventListener<ChatEventName>
			>
		}
		set.add(cb)
		return () => set!.delete(cb)
	}

	/** Request numbers of commands nobody waits for: their answer is dropped without a warning. */
	private readonly noReplyIds = new Map<number, string>()

	/**
	 * A command the page does not wait for (ackInbound, setRoutes, setNodes, pause, resume). It still carries a valid reqId: the SDK refuses a command with a
	 * missing or negative reqId at its entry (bad_request, reqId null), so a bare command is never accepted. The answer is ignored.
	 */
	private postNoReply(cmd: Record<string, unknown>): void {
		const reqId = nextChatTransportReqId()
		this.noReplyIds.set(reqId, String(cmd.type))
		if (this.noReplyIds.size > 200) this.noReplyIds.delete(this.noReplyIds.keys().next().value as number)
		this.postCommand({ ...cmd, reqId })
	}

	/** Exposed for history bridge / internal request helper. */
	request<T>(cmd: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
		if (this.destroyed) return Promise.reject(new Error('native chat destroyed'))
		const reqId = nextChatTransportReqId()
		const body = { ...cmd, reqId }
		// Correlation (PWA side only): the log carries the command type and the reqId, never the payload.
		const type = String(cmd.type)
		const startedAt = Date.now()
		this.log('info', `native chat request sent: type=${type} reqId=${reqId} limit=${timeoutMs}ms`)
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(reqId)
				this.log('warn', `native chat request timeout: type=${type} reqId=${reqId} after=${Date.now() - startedAt}ms`)
				reject(new Error(`native chat request timeout (${type})`))
			}, timeoutMs)
			this.pending.set(reqId, {
				resolve: (v) => {
					this.log('info', `native chat request answered: type=${type} reqId=${reqId} ms=${Date.now() - startedAt}`)
					resolve(v as T)
				},
				reject,
				timer,
			})
			try {
				this.postCommand(body)
			} catch (e) {
				clearTimeout(timer)
				this.pending.delete(reqId)
				reject(e instanceof Error ? e : new Error(String(e)))
			}
		})
	}

	/**
	 * 1: a page request that carries the inbound generation (send, group text, mailbox command). Nothing is
	 * sent before a generation has been announced. A request the native layer drops is resent once when the generation has not moved;
	 * `send_timeout` is an answer and is returned as a failure.
	 */
	private requestWithGeneration(
		build: (generation: number | undefined) => Record<string, unknown>,
		legacyTimeoutMs: number,
	): Promise<GenerationOutcome> {
		return requestWithInboundGeneration(build, {
			generation: latestInboundGeneration,
			send: (cmd, timeoutMs) => this.sendForGeneration(cmd, timeoutMs),
			declared: () => this.generationDeclared(),
			legacyTimeoutMs,
		})
	}

	/**
	 * True when the hello answer declares `inbound.generation.v1`. An older shell does not, and gets no field.
	 * Waits for the hello answer when one is on its way.
	 */
	private async generationDeclared(): Promise<boolean> {
		if (this.helloAnswer) await this.helloAnswer
		const negotiated = this.features.status === 'negotiated'
		const declared = negotiated && this.helloOffered.includes(INBOUND_GENERATION_CAPABILITY)
		// QA only: the declaration and the generation the page holds (the field is sent only when the hello declares it)
		const latest = latestInboundGeneration()
		if (process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true') qaLine('[send]', `gen declared=${declared ? 1 : 0} value=${typeof latest === 'number' ? latest : 'none'}`)
		return declared
	}

	/** One attempt of `requestWithGeneration`: the ack or a refusal, or `timeout` when no answer came in time. */
	private async sendForGeneration(cmd: Record<string, unknown>, timeoutMs: number): Promise<GenerationAttemptAnswer> {
		try {
			const result = await this.request<unknown>(cmd, timeoutMs)
			return { kind: 'ack', ok: true, result }
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e)
			if (message.startsWith('native chat request timeout')) return { kind: 'timeout' }
			return { kind: 'ack', ok: false, reason: message }
		}
	}

	private postCommand(cmd: Record<string, unknown>): void {
		assertNoKeyOverBridge(cmd, `${this.bridge.label} command`)
		this.bridge.postCommand(cmd)
	}

	private emit<K extends ChatEventName>(event: K, payload: ChatEventMap[K]): void {
		const set = this.listeners[event] as ListenerBag<K> | undefined
		if (!set) return
		for (const cb of set) {
			try {
				cb(payload)
			} catch {
				/* isolate */
			}
		}
	}

	private emitStatus(status: ChatStatus, detail?: string): void {
		this.emit('status', { status, detail })
		this.emit('log', {
			level: status === 'error' ? 'error' : 'info',
			message: `${this.bridge.label}: ${status}${detail ? ` (${detail})` : ''}`,
		})
	}

	private rejectPending(err: Error): void {
		for (const [, p] of this.pending) {
			clearTimeout(p.timer)
			p.reject(err)
		}
		this.pending.clear()
	}

	private attachNativeListener(): void {
		if (this.nativeListener || typeof window === 'undefined') return
		this.nativeListener = (ev: Event) => {
			const detail = (ev as CustomEvent).detail as Record<string, unknown> | undefined
			if (!detail || typeof detail !== 'object') return
			const action = String(detail.action || '')
			if (action === 'chatModuleSignRequest') {
				void this.handleSignRequest(detail)
				return
			}
			if (action === 'chatModuleEvent') {
				this.handleOutbound(detail.event ?? detail.payload ?? detail)
				return
			}
			// Native may also emit the WorkerOutbound shape at the top level.
			if (typeof detail.type === 'string' && String(detail.type).startsWith('event:')) {
				this.handleOutbound(detail)
			}
		}
		window.addEventListener(this.bridge.eventName, this.nativeListener)
	}

	private detachNativeListener(): void {
		if (!this.nativeListener || typeof window === 'undefined') return
		window.removeEventListener(this.bridge.eventName, this.nativeListener)
		this.nativeListener = null
	}

	/**
	 * The native module asks the page to sign (`chatModuleSignRequest`). The page signs only through the host signer
	 * (`config.signAccount`), which refuses in a shell (option A: no page-key fallback). Replies carry a short code, never
	 * the message or key material.
	 */
	private async handleSignRequest(detail: Record<string, unknown>): Promise<void> {
		const reqId = String(detail.reqId || '')
		const kind = String(detail.kind || 'eip191')
		const reply = (ok: boolean, signature?: string, error?: string) => {
			try {
				this.bridge.signResponse({
					reqId,
					ok,
					signature: signature || '',
					error: error || '',
				})
			} catch {
				/* ignore */
			}
		}
		try {
			if (kind === 'eip712') {
				const td = detail.typedData as
					| {
							domain?: ethers.TypedDataDomain
							types?: Record<string, Array<ethers.TypedDataField>>
							primaryType?: string
							value?: Record<string, unknown>
							message?: Record<string, unknown>
					  }
					| undefined
				// iOS sends the EIP-712 `message` key, Android sends both `value` and `message`.
				const value = td?.value ?? td?.message
				if (!td?.domain || !td.types || !value) {
					reply(false, undefined, 'bad_typed_data')
					return
				}
				if (td.primaryType === 'SetPointer' && this.historyBridge.legacyLoadInFlight) {
					// iOS 0.1.4 rewrites the unchanged index on every load; skip that relay write.
					reply(false, undefined, 'redundant_pointer_write')
					return
				}
				const { EIP712Domain: _omit, ...types } = td.types as Record<string, Array<ethers.TypedDataField>> & {
					EIP712Domain?: unknown
				}
				const sig = await this.config.signAccount({ kind: 'eip712', domain: td.domain, types, value })
				reply(true, sig)
				return
			}
			const message = String(detail.message || '')
			if (!message) {
				reply(false, undefined, 'empty_message')
				return
			}
			const sig = await this.config.signAccount({ kind: 'eip191', message })
			reply(true, sig)
		} catch {
			reply(false, undefined, 'sign_refused')
		}
	}

	private handleOutbound(raw: unknown): void {
		if (!raw || typeof raw !== 'object') return
		const msg = raw as Record<string, unknown>
		const type = String(msg.type || '')

		if (type === 'ready' || type === 'ack') {
			const reqId = Number(msg.reqId)
			const noReplyType = this.noReplyIds.get(reqId)
			if (noReplyType !== undefined) {
				this.noReplyIds.delete(reqId)
				if (type === 'ack' && msg.ok === false) this.log('warn', `${this.bridge.label}: a command nobody waits for was refused (${String(msg.error || 'unknown').slice(0, 40)})`)
				// QA only: the answer of setRoutes (accepted / dropped counts, or the refusal code), codes and integers only
				if (noReplyType === 'setRoutes') {
					const code = /^[a-z0-9_]{1,40}$/.test(String(msg.error ?? '')) ? String(msg.error) : 'none'
					const res = (msg.result ?? {}) as { accepted?: unknown; dropped?: unknown }
					if (process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true') qaLine('[send]', `routes ack ok=${msg.ok === true ? 1 : 0} error=${code} accepted=${Number.isInteger(res.accepted) ? res.accepted : -1} dropped=${Number.isInteger(res.dropped) ? res.dropped : -1}`)
				}
				return
			}
			const pending = this.pending.get(reqId)
			if (!pending) {
				// a reply after its request timed out, or an unknown reqId: logged (type and reqId only), nothing is resolved
				this.log('warn', `native chat reply with no pending request: type=${type} reqId=${String(msg.reqId)} (late or unknown)`)
				return
			}
			clearTimeout(pending.timer)
			this.pending.delete(reqId)
			if (type === 'ready' || msg.ok === true) {
				pending.resolve(msg.result)
			} else {
				pending.reject(new Error(String(msg.error || 'native_ack_failed')))
			}
			return
		}

		if (type === 'nodesRequest') {
			const reqId = Number(msg.reqId)
			void this.config
				.getNodes()
				.then((nodes) => {
					this.nodes = nodes || []
					this.postCommand({ type: 'nodesResponse', reqId, nodes: this.nodes })
				})
				.catch(() => {
					this.postCommand({ type: 'nodesResponse', reqId, nodes: this.nodes })
				})
			return
		}

		switch (type) {
			case 'event:message':
				this.emit('message', msg.payload as ChatEventMap['message'])
				break
			case 'event:group':
				this.emit('group', msg.payload as ChatEventMap['group'])
				break
			case 'event:delivery':
				this.emit('delivery', msg.payload as ChatEventMap['delivery'])
				break
			case 'event:presence':
				this.emit('presence', msg.payload as ChatEventMap['presence'])
				break
			case 'event:status': {
				const st = msg.payload as { status?: ChatStatus; detail?: string }
				this.emitStatus(st?.status || 'listening', st?.detail)
				break
			}
			case 'event:historyBuffer': {
				const batch = msg.payload as HistoryBufferEvent
				this.historyBridge._emit(batch)
				this.emit('historyBuffer', batch)
				break
			}
			case 'event:voiceFrame':
				this.emit('voiceFrame', msg.payload as ChatEventMap['voiceFrame'])
				break
			case 'event:voiceGap':
				this.emit('voiceGap', msg.payload as ChatEventMap['voiceGap'])
				break
			case 'event:voiceConflict':
				this.emit('voiceConflict', msg.payload as ChatEventMap['voiceConflict'])
				break
			case 'event:log':
				this.historyBridge._noteLog(String(msg.message || ''))
				this.emit('log', {
					level: (msg.level as 'info' | 'warn' | 'error') || 'info',
					message: String(msg.message || ''),
				})
				break
			default:
				break
		}
	}
}

/** Native chat client: {@link BeamioChatClient} plus the native-only daemon surface. */
export type NativeConetChatClient = BeamioChatClient & {
	readonly daemonFeatures: ChatDaemonFeatures
	ackInbound(armorHashes: string[]): void
}

export function isNativeConetChatClient(client: unknown): client is NativeConetChatClient {
	return client instanceof NativeConetChatClientImpl
}

/**
 * Native chat client for a shell. Defaults to the iOS bridge; the Android shell passes its own
 * {@link NativeChatBridge} (see `androidNativeChatClient.ts`).
 */
export function createNativeConetChatClient(
	config: NativeChatConfig,
	bridge: NativeChatBridge = IOS_NATIVE_CHAT_BRIDGE,
): NativeConetChatClient {
	return new NativeConetChatClientImpl(config, bridge)
}

/**
 * G1 start in a shell: init with the EOA only, then the client is torn down. The route and PGP
 * public keys are not sent. Returns the reason of a refusal (a code name, never a value).
 */
export async function initNativeIdentityOnly(
	config: NativeChatConfig,
	bridge: NativeChatBridge = IOS_NATIVE_CHAT_BRIDGE,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const client = new NativeConetChatClientImpl(config, bridge)
	try {
		await client.runInit(true)
		return { ok: true }
	} catch (e) {
		return { ok: false, reason: e instanceof Error ? e.message : 'init_failed' }
	} finally {
		// Local teardown only: the native layer gets no `destroy` from this one-shot client, whatever the outcome.
		client.teardownLocal()
	}
}

/** The identity a native chat client needs: public material only (the page holds no PGP private key on the native path). */
export type NativeChatIdentity = Pick<ChatIdentity, 'eoaAddress'> &
	Partial<Pick<ChatIdentity, 'pgpPublicKeyArmored' | 'ownRouteArmoredPublicKey'>>

/** The chat config of a native client: the SDK config without the browser PGP private key. */
export type NativeChatConfig = Omit<BeamioChatConfig, 'identity'> & { identity: NativeChatIdentity }
