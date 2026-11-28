/**
 * Main-thread {@link BeamioChatClient} implementation. Boots the gossip Worker,
 * marshals commands, and re-emits worker events. Zero openpgp/verify on the main
 * thread — all heavy crypto runs in the worker.
 *
 * The host supplies the Worker instance (via `workerFactory`) so the SDK stays
 * bundler-agnostic: CRA/Vite/webpack each create the worker their own way, e.g.
 * new Worker(new URL('@beamio/chat-sdk/worker', import.meta.url), { type: 'module' })
 */

import type {
	BeamioChatClient,
	BeamioChatConfig,
	ChatIdentity,
	BeamioChatHistory,
	ChatEventListener,
	ChatEventName,
	ChatRoute,
	GroupIssueRosterRequest,
	GroupIssueRosterResult,
	GroupIssueTombstoneRequest,
	GroupIssueTombstoneResult,
	GroupSendRequest,
	GroupSendResult,
	SendMessageOptions,
	HistoryBufferEvent,
	HistoryEntry,
	HistoryLoadOptions,
	HistoryReadOptions,
	NodeInfo,
	Unsubscribe,
	LocalPageResult,
	LocalViewport,
} from './types.js'
import { CHAT_DAEMON_PROTOCOL_VERSION } from './protocol.js'
import type {
	ChatDaemonHello,
	VoiceOfferArgs,
	FirstOpenRequest,
	FirstOpenResult,
	WorkerInbound,
	WorkerInitPayload,
	WorkerOutbound,
	WorkerSignRequest,
	WorkerSignResponse,
} from './protocol.js'
import type { VoiceCallV3Config } from './voice-v3.js'
import { negotiateChatDaemon } from './daemon.js'

export interface BeamioChatClientOptions {
	/**
	 * Host-created Worker running `@beamio/chat-sdk/worker`. Required — the SDK never
	 * hard-codes a worker URL so it works under any bundler / native shell.
	 */
	workerFactory: () => Worker
}

const DEFAULT_RUNTIME = {
	sendFanout: 3,
	reconnectBaseMs: 4_000,
	reconnectMaxMs: 30_000,
	outerWrap: true,
} as const

type Emitter = {
	[K in ChatEventName]: Set<ChatEventListener<K>>
}

class ChatHistoryBridge implements BeamioChatHistory {
	private bufferListeners = new Set<(batch: HistoryBufferEvent) => void>()

	constructor(private readonly client: BeamioChatClientImpl) {}

	load(options?: HistoryLoadOptions): Promise<void> {
		return this.client.request<void>({ type: 'historyLoad', reqId: 0, options })
	}

	append(entry: Omit<HistoryEntry, 'seq'>, opts?: { qaRemoteFault?: 'upload' | 'pointer' | 'timeout' }): Promise<void> {
		// the worker appends one record at a time (about 9 s each), so a queue of a few records needs more than the 20 s default; the page's own wait (120 s, inboundDurable.ts) is the one that decides, this stays above it
		return this.client.request<void>({ type: 'historyAppend', reqId: 0, entry, ...(process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && opts?.qaRemoteFault ? { qaRemoteFault: opts.qaRemoteFault } : {}) }, 125_000)
	}

	read(options?: HistoryReadOptions): Promise<HistoryEntry[]> {
		return this.client.request<HistoryEntry[]>({ type: 'historyRead', reqId: 0, options }, 60_000)
	}

	openConversation(convKey: string, viewport: LocalViewport): Promise<LocalPageResult> {
		return this.client.request<LocalPageResult>({ type: 'historyLocalOpen', reqId: 0, convKey, viewport }, 60_000)
	}

	loadOlder(convKey: string, cursor: string, viewport: LocalViewport): Promise<LocalPageResult> {
		return this.client.request<LocalPageResult>({ type: 'historyLocalLoadOlder', reqId: 0, convKey, cursor, viewport }, 60_000)
	}

	reportLayout(convKey: string, stableId: string, viewport: LocalViewport, wPt: number, hPt: number): Promise<{ written: boolean }> {
		return this.client.request<{ written: boolean }>({ type: 'historyLocalReportLayout', reqId: 0, convKey, stableId, viewport, wPt, hPt }, 60_000)
	}

	clearLocalCache(scope: 'conversation' | 'account', convKey?: string): Promise<{ removed: number; pendingKept: number }> {
		return this.client.request<{ removed: number; pendingKept: number }>({ type: 'historyLocalClear', reqId: 0, scope, convKey }, 60_000)
	}

	syncLocal(): Promise<void> {
		return this.client.request<void>({ type: 'historyLocalSync', reqId: 0 }, 10 * 60_000)
	}

	migrationState(): Promise<string> {
		return this.client.request<string>({ type: 'historyLocalMigrationState', reqId: 0 }, 60_000)
	}

	switchLocal(): Promise<boolean> {
		return this.client.request<boolean>({ type: 'historyLocalSwitch', reqId: 0 }, 60_000)
	}

	purgeLocalPlain(): Promise<number> {
		return this.client.request<number>({ type: 'historyLocalPurge', reqId: 0 }, 60_000)
	}

	unlockLocal(keys: { kIdHex: string; kIdxHex: string; dekHex: string }): Promise<void> {
		return this.client.request<void>({ type: 'historyLocalUnlock', reqId: 0, ...keys }, 60_000)
	}

	lockLocal(): Promise<void> {
		return this.client.request<void>({ type: 'historyLocalLock', reqId: 0 }, 60_000)
	}

	migrateLocal(extra: Array<{ peer: string; dir: 'in' | 'out'; ts: number; sendId?: string; body: string; pending?: boolean }>): Promise<{ verified: boolean; conversations: number }> {
		return this.client.request<{ verified: boolean; conversations: number }>({ type: 'historyLocalMigrate', reqId: 0, extra }, 10 * 60_000)
	}

	onBuffer(cb: (batch: HistoryBufferEvent) => void): Unsubscribe {
		this.bufferListeners.add(cb)
		return () => this.bufferListeners.delete(cb)
	}

	_emit(batch: HistoryBufferEvent): void {
		for (const cb of this.bufferListeners) {
			try {
				cb(batch)
			} catch {
				/* listener errors isolated */
			}
		}
	}
}

class BeamioChatClientImpl implements BeamioChatClient {
	private worker: Worker | null = null
	private reqSeq = 1
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
	private listeners: Emitter = {
		message: new Set(),
		delivery: new Set(),
		presence: new Set(),
		status: new Set(),
		log: new Set(),
		historyBuffer: new Set(),
		voiceFrame: new Set(),
		voiceGap: new Set(),
		voiceConflict: new Set(),
		group: new Set(),
	}
	private historyBridge: ChatHistoryBridge
	private routes: ChatRoute[] = []
	private nodes: NodeInfo[] = []
	private destroyed = false

	constructor(
		private readonly config: BeamioChatConfig,
		private readonly options: BeamioChatClientOptions,
	) {
		this.historyBridge = new ChatHistoryBridge(this)
	}

	get history(): BeamioChatHistory {
		return this.historyBridge
	}

	/** The last page-side step of init (R79-watchdog): where a start stalled. Read by the page when the ready watchdog fires. */
	private startStepName: 'idle' | 'worker_created' | 'nodes_loaded' | 'init_sent' | 'ready' = 'idle'

	get startStep(): string {
		return this.startStepName
	}

	async init(): Promise<void> {
		if (this.worker) return
		this.worker = this.options.workerFactory()
		this.startStepName = 'worker_created'
		this.worker.addEventListener('message', (ev: MessageEvent<WorkerOutbound>) => this.onWorkerMessage(ev.data))
		this.worker.addEventListener('error', (ev: ErrorEvent) => {
			const detail = ev.message || 'unknown worker error'
			this.emit('log', { level: 'error', message: `worker error: ${detail}` })
			this.rejectPending(new Error(`Chat worker failed: ${detail}`))
		})
		this.worker.addEventListener('messageerror', () => {
			const error = new Error('Chat worker message could not be deserialized')
			this.emit('log', { level: 'error', message: error.message })
			this.rejectPending(error)
		})
		this.nodes = await this.config.getNodes().catch(() => [])
		this.startStepName = 'nodes_loaded'
		this.routes = []
		const payload: WorkerInitPayload = {
			identity: workerIdentity(this.config.identity),
			conetRpcUrl: this.config.conetRpcUrl,
			addressPgpContractAddress: this.config.addressPgpContractAddress,
			ipfsBaseUrl: this.config.ipfsBaseUrl,
			ipfsWriteBaseUrl: this.config.ipfsWriteBaseUrl,
			chainId: this.config.chainId ?? 224422,
			chatIndexRegistryAddress:
				this.config.chatIndexRegistryAddress ?? '0x1511Caa71081C84d8a591490D1b83879088EED72',
			apiBaseUrl: this.config.apiBaseUrl,
			runtime: { ...DEFAULT_RUNTIME, ...(this.config.runtime ?? {}) },
			nodes: this.nodes,
			routes: this.routes,
		}
		// PGP unlock plus the first mailbox listen can exceed the default 20s
		// worker RPC budget. Destroying the worker at that point leaves the
		// next voice call with no live listen.
		this.startStepName = 'init_sent'
		await this.request<void>({ type: 'init', reqId: 0, payload }, 180_000)
		this.startStepName = 'ready'
	}

	/** `hello` (protocol v1). Null when the worker is not running or did not answer. */
	async hello(): Promise<ChatDaemonHello | null> {
		if (!this.worker) return null
		try {
			const result = await this.request<unknown>(
				{ type: 'hello', reqId: 0, protocolVersion: CHAT_DAEMON_PROTOCOL_VERSION },
				5_000,
			)
			return negotiateChatDaemon(result).status === 'negotiated' ? (result as ChatDaemonHello) : null
		} catch {
			return null
		}
	}

	setRoutes(routes: ChatRoute[]): void {
		this.routes = routes || []
		this.postCommand({ type: 'setRoutes', routes: this.routes })
	}

	/** Push a refreshed node snapshot into the worker (host owns discovery). */
	setNodes(nodes: NodeInfo[]): void {
		if (!nodes?.length) return
		this.nodes = nodes
		this.postCommand({ type: 'setNodes', nodes })
	}

	async sendGroupMessage(request: GroupSendRequest): Promise<GroupSendResult> {
		return this.request<GroupSendResult>({ type: 'sendGroup', reqId: 0, request }, 60_000)
	}

	async issueGroupRoster(request: GroupIssueRosterRequest): Promise<GroupIssueRosterResult> {
		return this.request<GroupIssueRosterResult>({ type: 'issueGroupRoster', reqId: 0, request }, 60_000)
	}

	async issueGroupTombstone(request: GroupIssueTombstoneRequest): Promise<GroupIssueTombstoneResult> {
		return this.request<GroupIssueTombstoneResult>({ type: 'issueGroupTombstone', reqId: 0, request }, 60_000)
	}

	async sendMessage(to: ChatRoute, payload: string, opts?: SendMessageOptions): Promise<{ sendId: string }> {
		const sendId = opts?.sendId || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
		await this.request<unknown>({
			type: 'send',
			reqId: 0,
			to,
			payload,
			sendId,
			beamioNoPush: opts?.beamioNoPush,
		})
		return { sendId }
	}

	async queryPresence(contacts: ChatRoute[]): Promise<Record<string, boolean>> {
		return this.request<Record<string, boolean>>({ type: 'queryPresence', reqId: 0, contacts })
	}

	/** After presence: true/false when the mailbox lookup is trusted; null when it is not. */
	async queryNativeWake(contact: ChatRoute): Promise<boolean | null> {
		return this.request<boolean | null>({ type: 'queryNativeWake', reqId: 0, contact })
	}

	async firstOpen(request: FirstOpenRequest): Promise<FirstOpenResult> {
		return this.request<FirstOpenResult>({ type: 'firstOpen', reqId: 0, request }, 60_000)
	}

	/** Encrypt & POST an arbitrary mailbox command (e.g. gossip_delivery_ack) to route B via entry C ≠ B. */
	async postMailboxCommand(
		routerArmoredPublicKey: string,
		command: Record<string, unknown>,
	): Promise<boolean> {
		const r = await this.request<{ sent: boolean }>({
			type: 'mailboxCommand',
			reqId: 0,
			routerArmoredPublicKey,
			command,
		})
		return !!r?.sent
	}

	/** Encrypt and post a command to this wallet's own mailbox route. */
	async postOwnMailboxCommand(command: Record<string, unknown>): Promise<boolean> {
		const r = await this.request<{ sent: boolean }>({
			type: 'ownMailboxCommand',
			reqId: 0,
			command,
		})
		return !!r?.sent
	}

	async sendVoiceFrame(routerArmoredPublicKey: string, frame: Record<string, unknown>): Promise<boolean> {
		const r = await this.request<{ sent: boolean }>({
			type: 'voiceFrame',
			reqId: 0,
			routerArmoredPublicKey,
			frame,
		})
		return !!r?.sent
	}

	async startVoiceListen(sessionId: string, call?: VoiceCallV3Config): Promise<boolean> {
		// Two relay handshakes (12 s each, a retry on another relay) can run past 25 s.
		const r = await this.request<{ started: boolean }>({ type: 'voiceListen', reqId: 0, sessionId, call }, 45_000)
		return !!r?.started
	}

	async sendVoiceOffer(offer: VoiceOfferArgs): Promise<{ ok: boolean; pushed: boolean }> {
		const r = await this.request<{ ok: boolean; pushed: boolean }>({ type: 'voiceOffer', reqId: 0, offer }, 30_000)
		return { ok: !!r?.ok, pushed: !!r?.pushed }
	}

	async stopVoiceListen(sessionId: string): Promise<boolean> {
		const r = await this.request<{ stopped: boolean }>({ type: 'voiceUnlisten', reqId: 0, sessionId })
		return !!r?.stopped
	}

	on<K extends ChatEventName>(event: K, cb: ChatEventListener<K>): Unsubscribe {
		this.listeners[event].add(cb as never)
		return () => this.listeners[event].delete(cb as never)
	}

	pause(): void {
		this.postCommand({ type: 'pause' })
	}

	resume(): void {
		this.postCommand({ type: 'resume' })
	}

	destroy(): void {
		if (this.destroyed) return
		this.destroyed = true
		this.postCommand({ type: 'destroy' })
		for (const { reject } of this.pending.values()) reject(new Error('client destroyed'))
		this.pending.clear()
		try {
			this.worker?.terminate()
		} catch {
			/* ignore */
		}
		this.worker = null
	}

	// ---- internals ------------------------------------------------------------
	request<T>(cmd: WorkerInbound & { reqId: number }, timeoutMs = 20_000): Promise<T> {
		if (!this.worker) return Promise.reject(new Error('client not initialised'))
		const reqId = this.reqSeq++
		const message = { ...cmd, reqId } as WorkerInbound
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (!this.pending.has(reqId)) return
				this.pending.delete(reqId)
				reject(new Error('Chat worker did not respond'))
			}, timeoutMs)
			this.pending.set(reqId, {
				resolve: (value) => {
					clearTimeout(timer)
					resolve(value as T)
				},
				reject: (error) => {
					clearTimeout(timer)
					reject(error)
				},
			})
			try {
				this.worker!.postMessage(message)
			} catch (error) {
				this.pending.delete(reqId)
				clearTimeout(timer)
				reject(error instanceof Error ? error : new Error(String(error)))
			}
		})
	}

	private rejectPending(error: Error): void {
		for (const { reject } of this.pending.values()) reject(error)
		this.pending.clear()
	}

	private postCommand(cmd: WorkerInbound | WorkerSignResponse): void {
		this.worker?.postMessage(cmd)
	}

	/**
	 * The worker asks for one account signature. The host signs with `config.signAccount` and answers with the signature only.
	 * A refusal answers `sign_refused` (no message text, no key material).
	 */
	private async answerSignRequest(msg: WorkerSignRequest): Promise<void> {
		const reply = (ok: boolean, signature?: string, error?: string): void => {
			this.postCommand({ type: 'signResponse', reqId: msg.reqId, ok, signature, error })
		}
		try {
			const signature = await this.config.signAccount(msg.request)
			if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
				reply(false, undefined, 'bad_signature')
				return
			}
			reply(true, signature)
		} catch {
			reply(false, undefined, 'sign_refused')
		}
	}

	private emit<K extends ChatEventName>(event: K, payload: Parameters<ChatEventListener<K>>[0]): void {
		for (const cb of this.listeners[event]) {
			try {
				;(cb as ChatEventListener<K>)(payload)
			} catch {
				/* isolate listener errors */
			}
		}
	}

	private onWorkerMessage(msg: WorkerOutbound | WorkerSignRequest): void {
		switch (msg.type) {
			case 'signRequest':
				void this.answerSignRequest(msg)
				return
			case 'ready':
			case 'ack': {
				const reqId = msg.reqId
				const p = this.pending.get(reqId)
				if (!p) return
				this.pending.delete(reqId)
				if (msg.type === 'ready') {
					p.resolve(undefined)
				} else if (msg.ok) {
					p.resolve(msg.result)
				} else {
					p.reject(new Error(msg.error))
				}
				return
			}
			case 'event:message':
				this.emit('message', msg.payload)
				return
			case 'event:group':
				this.emit('group', msg.payload)
				return
			case 'event:delivery':
				this.emit('delivery', msg.payload)
				return
			case 'event:presence':
				this.emit('presence', msg.payload)
				return
			case 'event:status':
				this.emit('status', msg.payload)
				return
			case 'event:historyBuffer':
				this.emit('historyBuffer', msg.payload)
				this.historyBridge._emit(msg.payload)
				return
			case 'event:voiceFrame':
				this.emit('voiceFrame', msg.payload)
				return
			case 'event:voiceGap':
				this.emit('voiceGap', msg.payload)
				return
			case 'event:voiceConflict':
				this.emit('voiceConflict', msg.payload)
				return
			case 'event:log':
				this.emit('log', { level: msg.level, message: msg.message })
				return
			case 'nodesRequest': {
				void this.config
					.getNodes()
					.then((nodes) => {
						this.nodes = nodes
						this.postCommand({ type: 'nodesResponse', reqId: msg.reqId, nodes } as WorkerInbound)
					})
					.catch(() => {
						this.postCommand({ type: 'nodesResponse', reqId: msg.reqId, nodes: this.nodes } as WorkerInbound)
					})
				return
			}
			default:
				return
		}
	}
}

/**
 * The identity the worker receives. Copied field by field: the account key is never part of it (2026-11-13), so an extra
 * field a host adds cannot cross into the worker.
 */
function workerIdentity(identity: ChatIdentity): ChatIdentity {
	return {
		eoaAddress: identity.eoaAddress,
		pgpPrivateKeyArmored: identity.pgpPrivateKeyArmored,
		pgpPassphrase: identity.pgpPassphrase,
		pgpPublicKeyArmored: identity.pgpPublicKeyArmored,
		ownRouteArmoredPublicKey: identity.ownRouteArmoredPublicKey,
	}
}

/** Factory: create a chat client. Call `init()` before use. */
export function createBeamioChatClient(
	config: BeamioChatConfig,
	options: BeamioChatClientOptions,
): BeamioChatClient & {
	setNodes(nodes: NodeInfo[]): void
	postMailboxCommand(
		routerArmoredPublicKey: string,
		command: Record<string, unknown>,
	): Promise<boolean>
} {
	return new BeamioChatClientImpl(config, options)
}

/**
 * The automatic first open in its own worker (plan step c). The gossip client is not started yet at the key stage, so this creates a worker
 * for the one command and ends it. The worker's account signatures (registration) are answered by `signAccount` (the host's signer). The
 * answer is the status and the key ID only; the worker is terminated after the answer, the timeout or a refusal.
 */
export function runFirstOpenInWorker(
	workerFactory: () => Worker,
	request: FirstOpenRequest,
	signAccount: (req: import('./signer.js').AccountSignRequest) => Promise<string>,
	timeoutMs = 90_000,
): Promise<FirstOpenResult> {
	return new Promise<FirstOpenResult>((resolve, reject) => {
		const worker = workerFactory()
		const reqId = 1
		let settled = false
		const finish = (fn: () => void) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			worker.terminate()
			fn()
		}
		const timer = setTimeout(() => finish(() => reject(new Error('first_open_timeout'))), timeoutMs)
		worker.onmessage = (ev: MessageEvent) => {
			const msg = ev.data as { type?: string; reqId?: number; ok?: boolean; result?: FirstOpenResult; error?: string; request?: import('./signer.js').AccountSignRequest }
			if (msg?.type === 'signRequest') {
				const sreq = msg.reqId as number
				void signAccount(msg.request as import('./signer.js').AccountSignRequest)
					.then((signature) => worker.postMessage({ type: 'signResponse', reqId: sreq, ok: true, signature }))
					.catch(() => worker.postMessage({ type: 'signResponse', reqId: sreq, ok: false, error: 'sign_refused' }))
				return
			}
			if (msg?.type === 'ack' && msg.reqId === reqId) {
				if (msg.ok && msg.result) finish(() => resolve(msg.result as FirstOpenResult))
				else finish(() => reject(new Error(msg.error || 'first_open_failed')))
			}
		}
		worker.onerror = () => finish(() => reject(new Error('first_open_worker_error')))
		worker.postMessage({ type: 'firstOpen', reqId, request })
	})
}
