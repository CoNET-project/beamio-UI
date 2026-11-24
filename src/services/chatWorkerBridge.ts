/**
 * Bridge between SilentPassUI `services/chat.ts` and `@conet.project/chat-sdk`
 * worker client **or** native Conet Chat Modules:
 * - Browser: TS Worker (`makeGossipWorker`)
 * - iOS shell (`CashTreesIOS` / WK handler): `nativeConetChatTransport` (1B)
 * - Android shell (`CashTreesAndroid`): `androidNativeChatClient`
 *
 * **Iron rule:** when the PWA runs inside a native WebView shell
 * (`isCashTreesNativeWebView`), **never** call `makeGossipWorker()` /
 * `createBeamioChatClient` — chat-sdk must not load into a Worker. Prefer iOS
 * shell first, else Android.
 *
 * Routing: listen encrypted to mailbox B via entry C ≠ B; never direct-connect B.
 */

import { nativeReceiptPath } from './receiptCapability'
import { isShellContext } from './shellContext'
import { sharedOfferGate } from './routeOfferGate'
import { invalidateStoredTrust } from './receiptRouteTrust'
import { createRouteTable, applyRouteEligibility, type RouteTable, type RouteEligibility } from './nativeRouteTable'
import { onShellPublicEoaChange, shellPublicEoaOrEmpty } from './nativeIdentityPublic'
import { qaSendStage, qaLine, qaErrorName, qaErrorCode } from '@/utils/qaLog'
import { NATIVE_CLIENT_HAS_LOCAL_LIBRARY } from './historyCapability'
import {
	createBeamioChatClient,
	runFirstOpenInWorker,
	type FirstOpenRequest,
	type FirstOpenResult,
	type AccountSignRequest,
	hasCapability,
	negotiateChatDaemon,
	type BeamioChatClient,
	type ChatDaemonCapability,
	type ChatDaemonFeatures,
	type BeamioChatConfig,
	type ChatRoute,
	type HistoryBufferEvent,
	type HistoryEntry,
	type HistoryLoadOptions,
	type HistoryReadOptions,
	type NodeInfo,
	type VoiceCallV3Config,
	type VoiceOfferArgs,
	type VoiceConflictEvent,
	type VoiceFrame,
	type VoiceGapEvent,
	type GroupInboundEvent,
	type GroupIssueRosterRequest,
	type GroupIssueRosterResult,
	type GroupIssueTombstoneRequest,
	type GroupIssueTombstoneResult,
	type GroupSendRequest,
	type GroupSendResult,
	type ChatLocalClearResult,
	type ChatLocalPageResult,
	type ChatLocalViewport,
	type AccountSignFn,
} from '@conet.project/chat-sdk'
import { CONET_ADDRESS_PGP, CONET_CHAT_INDEX_REGISTRY } from '../config/chainAddresses'
import {
	createAndroidNativeChatClient,
	preferAndroidNativeChatClient,
} from './androidNativeChatClient'
import { initAndroidIdentityOnly } from './androidNativeChatClient'
import { isCashTreesNativeWebView } from '../utils/cashTreesNativeNfc'
import { isShellBuildKind } from '../utils/shellBuildFlag'
import { shellChatBlockedNow } from './shellChatCapability'
import { isPgpRestoreFailure, setPgpRestoreFailure } from './pgpRestore'
import {
	createNativeConetChatClient,
	initNativeIdentityOnly,
	type NativeChatConfig,
	isCashTreesIosShell,
	isNativeConetChatClient,
	preferIosNativeChatClient,
} from './nativeConetChatTransport'
import { ackInboundHashesInBrowser } from './browserInboundAck'
import { createHistoryLoadGate, type HistoryLoadCaller } from './historyLoadGate'
import { inboundLineForAccount } from './historyClientBinding'
import { createHistoryLoadPath } from './historyLoadPath'
import { createHistoryTailWaiter } from './historyTailWaiter'
import { hasInboundDedupeMarker } from '../utils/inboundDedupeStore'
import { issueInboundAck, type InboundAckTarget } from './inboundBatchSettle'
import { postAndroidChatCommand } from '../utils/androidChatChannel'
import { BEAMIO_WALLET_READY_EVENT } from '../utils/beamioWalletReadyEvent'
import { NATIVE_WALLET_ESTABLISHED_EVENT } from './nativeWalletEstablished'
import { createInitRefusalLatch, type IdentityClosedInitReason } from './nativeInitRefusal'
import { isMailboxAckSent, noteMailboxAckSent } from '../utils/chatDeliveryReceipt'
import { WORKER_READY_TIMEOUT, WorkerReadyTimeout, withWorkerReadyWatchdog } from './workerReadyWatchdog'
import { chatAccessRefused } from './passcode/chatAccessGuard'

/** True when any native shell path must own Chat (no TS gossip Worker). */
function mustUseNativeChatBridge(): boolean {
	if (typeof window === 'undefined') return false
	return (
		isCashTreesNativeWebView() ||
		preferIosNativeChatClient() ||
		preferAndroidNativeChatClient()
	)
}

const CONET_RPC_URL = 'https://rpc1.conet.network'
const IPFS_BASE_URL = 'https://ipfs.conet.network/api'
/**
 * Cluster API base for the gasless ChatIndexRegistry pointer relay. The SDK appends
 * `/setChatIndexPointer` — matching the `x402sdk` router mounted at `/api` (see
 * beamioServer). Keep in sync with `services/AAaccount.beamioApiBase`.
 */
const BEAMIO_API_BASE_URL = 'https://beamio.ca/api'

/** TS Worker client or Android native adapter — both implement BeamioChatClient. */
type ChatWorkerClient = BeamioChatClient

/** Only one listen client is alive per process. A new session replaces the old. */
let activeClient: ChatWorkerClient | null = null
/** the account the active client was created for (lower case). Fixed at creation; never follows a later account change. */
let activeClientEoa: string | null = null
let activeClientIsNative = false
/** the account the page holds now (lower case), or null before the page knows one. Set by the App (App.tsx). */
let currentAccountGetter: (() => string) | null = null
export const setCurrentAccountGetter = (fn: (() => string) | null): void => {
	currentAccountGetter = fn
}

/** The account the active worker client is bound to (lower case), or null when there is no client. Reads and buffer batches are checked
 * against it (historyClientBinding.ts), so an old client never feeds a new account. */
export const boundAccountOfActiveClient = (): string | null => (activeClient ? activeClientEoa : null)

/**
 * The contact routes handed to the native module for its own delivered-receipt path (nativeRouteTable.ts). Memory only. The table is sent only
 * while a native client with the send capability is active; otherwise it is kept and sent again when the native chat has started.
 */
export const nativeRoutes: RouteTable = createRouteTable({
	send: (routes) => {
		if (!nativeReceiptPath() || !activeClient || !activeClientIsNative || !nativeSendReady()) return false
		activeClient.setRoutes(routes)
		return true
	},
})
/** A contact's route becomes known (a successful recipient lookup, an inbound sender): offered to the native module, for a contact the page already knows. */
export const noteNativeContactRoute = (address: string, userPublicKeyArmored: string, routerArmoredPublicKey: string): boolean =>
	nativeReceiptPath() ? nativeRoutes.note(address, userPublicKeyArmored, routerArmoredPublicKey) : false
/** One eligibility of a contact's receipt route (offer, keep, remove); only on the native receipt path. */
export const applyNativeRouteEligibility = (
	address: string,
	eligibility: RouteEligibility,
	route: { publicArmored: string; routersArmoreds: string } | undefined,
): 'offered' | 'removed' | 'unchanged' => applyRouteEligibility(nativeRoutes, nativeReceiptPath, address, eligibility, route)
/** An account change or an identity clear: the route table, the offer gate's spacing records and its running reads all go (nothing of the old account stays). */
export const clearNativeRouteState = (): void => {
	nativeRoutes.clear()
	sharedOfferGate.reset()
	invalidateStoredTrust()
}
/** The own account changed to another one: no route of the old account is kept or sent. */
let lastOwnEoaForRoutes = ''
onShellPublicEoaChange(() => {
	const eoa = shellPublicEoaOrEmpty().toLowerCase()
	if (lastOwnEoaForRoutes && eoa !== lastOwnEoaForRoutes) clearNativeRouteState()
	lastOwnEoaForRoutes = eoa
})

/** `hello` result of the active daemon (`legacy` until it answers, or for daemons before protocol v1). */
let activeFeatures: ChatDaemonFeatures = negotiateChatDaemon(null)

/** What the running chat daemon negotiated. Decide by capability, never by "does this method exist". */
export const getChatDaemonFeatures = (): ChatDaemonFeatures => activeFeatures

/**
 * True when the active daemon negotiated `cap`, or predates protocol v1 (no
 * `hello`): then the caller keeps its pre-v1 behaviour.
 */
const daemonAllows = (cap: ChatDaemonCapability): boolean =>
	activeFeatures.status !== 'negotiated' || hasCapability(activeFeatures, cap)

const NATIVE_SEND_READY_WAIT_MS = 10_000

/** The native daemon is up and negotiated `send.mailboxWrap`. */
const nativeSendReady = (): boolean =>
	!!activeClient && activeClientIsNative &&
	activeFeatures.status === 'negotiated' && hasCapability(activeFeatures, 'send.mailboxWrap')

/**
 * Native shells send chat only through the native daemon, which signs,
 * encrypts to the recipient, wraps to the recipient's mailbox and posts
 * through one entry at a time. While the daemon is starting (app launch,
 * native restart) this waits up to 10 s; then the send fails and the page's
 * resend handles it. The page never posts chat itself inside a shell.
 */
export async function sendChatViaNativeDaemon(
	to: ChatRoute,
	payload: string,
	opts?: { beamioNoPush?: boolean },
): Promise<boolean> {
	// unit e: the UI lock refuses the send before any bridge request.
	if (chatAccessRefused('send')) {
		qaSendStage('access_refused')
		return false
	}
	const deadline = Date.now() + NATIVE_SEND_READY_WAIT_MS
	while (!nativeSendReady() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 200))
	}
	const client = activeClient
	if (!client || !nativeSendReady()) {
		console.warn('[chat] native daemon not ready after 10 s; send failed')
		qaSendStage('daemon_not_ready')
		return false
	}
	try {
		await client.sendMessage(to, payload, opts?.beamioNoPush ? { beamioNoPush: true } : undefined)
		return true
	} catch (e) {
		qaSendStage(`native_error:${String((e as { code?: unknown })?.code ?? (e as Error)?.name ?? 'unknown').slice(0, 40)}`)
		return false
	}
}

/**
 * Inbound line → mailbox armor hashes waiting for the page to store the line.
 * Native: the module sends the server ACK at store time; the sender receipt and the armor clean-up wait for the page to show the
 * message (`ackInbound`).
 */
const pendingInboundAcks = new Map<string, Set<string>>()
const PENDING_INBOUND_ACK_MAX = 500

/** True when the page acknowledges inbound lines itself (browser TS Worker). Native shells: false. */
export const inboundAckIsBrowser = (): boolean => !!activeClient && !activeClientIsNative

/** Armor hashes of these inbound lines. Reads only; the pending list is not changed. */
export const inboundArmorHashesOf = (lines: readonly string[]): string[] => {
	const hashes: string[] = []
	for (const line of lines) {
		const set = pendingInboundAcks.get(line)
		if (set) hashes.push(...set)
	}
	return hashes
}

/** True when this inbound line was already handled and marked: the mailbox is redelivering it after a lost ACK (browser). */
export const isInboundLineMarked = (line: string): boolean =>
	inboundAckIsBrowser() && inboundArmorHashesOf([line]).some((h) => hasInboundDedupeMarker(h))

/**
 * Drops the pending entries of these lines after a successful store commit. A failed commit keeps them, so the redelivery
 * is matched again.
 */
export const releaseInboundLines = (lines: readonly string[]): void => {
	for (const line of lines) pendingInboundAcks.delete(line)
}

/**
 * The ACK target of one store step, captured at store time: the client and the capability are read now, not when the commit
 * resolves. Browser: the mailbox ACK goes through this page's own worker client. Native: `ackInbound` goes to the module only when it
 * declares `inbound.deferAck`; otherwise nothing is sent and the module keeps the armor.
 */
/** Armor hashes for which `ackInbound`was sent in this page session. Bounded; the oldest go first. */
const nativeAckedHashes = new Set<string>()
const NATIVE_ACKED_MAX = 5000

export const captureInboundAckTarget = (): InboundAckTarget => {
	const client = activeClient
	if (client && !activeClientIsNative) {
		const browserClient = client
		const eoa = lastGossipParams ? lastGossipParams.eoaAddress : ''
		return {
			browser: true,
			alreadyAcked: () => false,
			ackMailbox: (armorHashes) => {
				void ackInboundHashesInBrowser(armorHashes, {
					eoa,
					post: (command) => browserClient.postOwnMailboxCommand(command),
					isSent: isMailboxAckSent,
					noteSent: noteMailboxAckSent,
				})
			},
			ackDisplayed: () => undefined,
		}
	}
	const native = client && isNativeConetChatClient(client) && daemonAllows('inbound.deferAck') ? client : null
	return {
		browser: false,
		alreadyAcked: (armorHash) => nativeAckedHashes.has(armorHash),
		ackMailbox: () => undefined,
		// Recorded only when the call is made: no client, or a throw, leaves the hashes unrecorded.
		ackDisplayed: (armorHashes) =>
			void issueInboundAck(native ? (hashes) => native.ackInbound(hashes) : null, armorHashes, (h) => {
				nativeAckedHashes.add(h)
				if (nativeAckedHashes.size > NATIVE_ACKED_MAX) {
					const oldest = nativeAckedHashes.values().next().value
					if (oldest) nativeAckedHashes.delete(oldest)
				}
			}),
	}
}
let workerInitPromise: Promise<boolean> | null = null
let lastGossipParams: StartWorkerGossipParams | null = null

type VoiceRelayRequest = {
	/** Own voice channel of the v3 call. */
	sessionId: string
	/** The call's channels (memory only). Kept so a restarted worker can reopen them. */
	call?: VoiceCallV3Config
}

/** Survives a gossip-worker restart so an in-progress call can reopen its mailbox SSE. */
let activeVoiceRelay: VoiceRelayRequest | null = null
let voiceRelayOpen: Promise<boolean> | null = null
let voiceRelayOpenSessionId = ''

/**
 * Host subscribers to encrypted-history restore/append buffer batches. Registered
 * independently of the worker session lifecycle so a page can `onHistoryBuffer`
 * before or after `startWorkerGossipListen()`; the active client fans batches here.
 */
const historyBufferListeners = new Set<(batch: HistoryBufferEvent, boundEoa: string) => void>()
const voiceFrameListeners = new Set<(frame: VoiceFrame) => void>()
const voiceGapListeners = new Set<(event: VoiceGapEvent) => void>()
const voiceConflictListeners = new Set<(event: VoiceConflictEvent) => void>()
const groupInboundListeners = new Set<(event: GroupInboundEvent) => void>()

/** single-flight, dirty re-run, minimum interval and the numbers-only log (historyLoadGate.ts). */
const historyLoadGate = createHistoryLoadGate()
/** The caller of the next listen start's history load: a foreground resume is reported by chat.ts before the restart. */
let listenLoadCaller: HistoryLoadCaller | null = null

/** chat.ts reports why the gossip listen is restarting. Only a foreground resume bypasses the load interval. */
export function noteHistoryResumeReason(reason: string): void {
	if (reason === 'foreground_resume') listenLoadCaller = 'foreground_resume'
}

const consumeListenLoadCaller = (): HistoryLoadCaller => {
	const caller = listenLoadCaller ?? 'listen_start'
	listenLoadCaller = null
	return caller
}

/**
 * Subscribe to encrypted-history buffer batches (restore tail/backfill + live append
 * mirror). Idempotent unsubscribe. Safe to call with no active worker client.
 */
export const onHistoryBuffer = (cb: (batch: HistoryBufferEvent, boundEoa: string) => void): (() => void) => {
	historyBufferListeners.add(cb)
	return () => {
		historyBufferListeners.delete(cb)
	}
}

export const onVoiceFrame = (cb: (frame: VoiceFrame) => void): (() => void) => {
	voiceFrameListeners.add(cb)
	return () => voiceFrameListeners.delete(cb)
}
export const onVoiceGap = (cb: (event: VoiceGapEvent) => void): (() => void) => {
	voiceGapListeners.add(cb)
	return () => voiceGapListeners.delete(cb)
}
export const onVoiceConflict = (cb: (event: VoiceConflictEvent) => void): (() => void) => {
	voiceConflictListeners.add(cb)
	return () => voiceConflictListeners.delete(cb)
}

export const onGroupInbound = (cb: (event: GroupInboundEvent) => void): (() => void) => {
	groupInboundListeners.add(cb)
	return () => groupInboundListeners.delete(cb)
}

export const issueWorkerGroupRoster = async (
	request: GroupIssueRosterRequest,
): Promise<GroupIssueRosterResult> => {
	const client = activeClient
	if (!client) throw new Error('Chat is not connected')
	return client.issueGroupRoster(request)
}

export const sendWorkerGroupMessage = async (request: GroupSendRequest): Promise<GroupSendResult> => {
	if (chatAccessRefused('send')) throw new Error('Chat is locked')
	const client = activeClient
	if (!client) throw new Error('Chat is not connected')
	return client.sendGroupMessage(request)
}

export const issueWorkerGroupTombstone = async (
	request: GroupIssueTombstoneRequest,
): Promise<GroupIssueTombstoneResult> => {
	const client = activeClient
	if (!client) throw new Error('Chat is not connected')
	return client.issueGroupTombstone(request)
}

const runHistoryLoad = async (options?: HistoryLoadOptions): Promise<void> => {
	const client = activeClient
	if (!client) return
	try {
		await client.history.load(options)
	} catch (ex) {
		console.warn(
			'[chatHistory] history.load failed:',
			(ex as Error)?.message ?? String(ex),
		)
	}
}

/**
 * The load path (historyLoadPath.ts): a request before the worker client exists is queued (the race fix: `initChat`sets React
 * `gossip=true` before the client exists, and App effects do not retry), and the queue is flushed by the first ready request.
 */
/**
 * Completion signal of the history load (historyTailWaiter.ts): a tail batch (`isTail`) of the active worker client means the on-chain
 * pointer was read, the IPFS index fetched and the tail decrypted. The chat preheat waits on it (awaitWorkerHistoryTail).
 */
const HISTORY_TAIL_TIMEOUT_MS = 90_000
const historyTail = createHistoryTailWaiter()

const historyLoadPath = createHistoryLoadPath<HistoryLoadOptions>({
	gate: historyLoadGate,
	runLoad: runHistoryLoad,
	onQueued: () => console.info('[chatHistory] load queued — worker not ready yet'),
})

/**
 * Restore encrypted history from the on-chain head pointer (RPC `getPointer(eoa)`) →
 * IPFS index → decrypt tail → backfill.
 *
 * If the gossip worker is not ready yet, queues the load and runs it automatically
 * when {@link startWorkerGossipListen} finishes init (recover / LoadingPage race).
 */
export const loadWorkerHistory = async (
	options?: HistoryLoadOptions,
	caller: HistoryLoadCaller = 'other',
): Promise<void> => {
	// unit e: no history load while the UI is locked (no bridge request).
	if (chatAccessRefused('history_load')) return
	// the load's new entries reach the page through the history buffer (see the buffer handler below). Nothing is read back and
	// re-sent to the listeners after a load: that replayed the whole history on every gossip restart.
	await historyLoadPath.load(options, caller, activeClient !== null)
}

/**
 * Append a sent/received entry to encrypted history (local mirror + IPFS fragment +
 * on-chain head pointer via the gasless relay). Best-effort: no-ops when no worker
 * client is active. Never throws into the message-store path.
 */
export const appendWorkerHistory = async (
	entry: Omit<HistoryEntry, 'seq'>,
): Promise<void> => {
	if (!activeClient) return
	try {
		await activeClient.history.append(entry)
	} catch {
		/* best-effort persist; the local profile.chats mirror is still authoritative */
	}
}

/**
 * Global decrypted history. UI must call this instead of fetching IPFS fragments.
 * `null` means the worker is not ready — keep the last trusted transcript.
 * A `query` searches the whole local corpus (message text, call status, file name).
 */
export const awaitWorkerHistoryTail = (): Promise<boolean> =>
	historyTail.await(() => activeClient, HISTORY_TAIL_TIMEOUT_MS)

export const readDecryptedChatHistory = async (
	options?: HistoryReadOptions,
): Promise<HistoryEntry[] | null> => {
	if (chatAccessRefused('history_read')) return null
	if (!activeClient) return null
	try {
		return await activeClient.history.read(options)
	} catch {
		return null
	}
}

/**
 * Local chat library. Every call returns `null` when the active client has no local
 * library (native shells, older daemons) or the call failed: callers keep the existing path.
 * Reads never wait for the full sync.
 */
export const openLocalChatPage = async (
	convKey: string,
	viewport: ChatLocalViewport,
): Promise<ChatLocalPageResult | null> => {
	if (chatAccessRefused('local_read')) return null
	const h = activeClient?.history
	if (!h || typeof h.openConversation !== 'function') return null
	try {
		return await h.openConversation(convKey, viewport)
	} catch {
		return null
	}
}

/**
 * The page's read result for the signal. A chat with no local library or no record answers `no_library` (a normal empty session,
 * never a notice); a read that fails or cannot be opened answers `read_error` (unreadable). openLocalChatPage keeps its null for the merge.
 */
export type LocalChatHistoryRead = { kind: 'page'; source: string; items: number } | { kind: 'no_library' } | { kind: 'not_ready' } | { kind: 'read_error' }
export const readLocalChatHistory = async (convKey: string, viewport: ChatLocalViewport): Promise<LocalChatHistoryRead> => {
	// unit e: locked is not judged as a result (the page shows nothing); no bridge request.
	if (chatAccessRefused('local_read')) return { kind: 'not_ready' }
	const h = activeClient?.history
	// no history client yet: not ready, nothing is judged
	if (!h || typeof h.openConversation !== 'function') return { kind: 'not_ready' }
	// a native shell client has no page-side local library (its openConversation is a stub): no judgement, no notice
	if (activeClientIsNative && !NATIVE_CLIENT_HAS_LOCAL_LIBRARY) {
		if (process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true') qaLine('[persist]', 'local_read kind=not_ready reason=no_local_library')
		return { kind: 'not_ready' }
	}
	try {
		const page = await h.openConversation(convKey, viewport)
		// a chat with no local library or no record: a normal empty session
		if (!page) {
			if (process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true') qaLine('[persist]', 'local_read kind=no_library')
			return { kind: 'no_library' }
		}
		// QA only: the page source decides whether the history notice shows (anything but local is unreadable)
		if (process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true') qaLine('[persist]', `local_read kind=page source=${String(page.source)} items=${page.items.length}`)
		return { kind: 'page', source: page.source, items: page.items.length }
	} catch (e) {
		if (process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true') qaLine('[persist]', `local_read kind=read_error name=${qaErrorName(e)} code=${qaErrorCode(e)} op=openConversation`)
		return { kind: 'read_error' }
	}
}

export const loadOlderLocalChatPage = async (
	convKey: string,
	cursor: string,
	viewport: ChatLocalViewport,
): Promise<ChatLocalPageResult | null> => {
	if (chatAccessRefused('local_read')) return null
	const h = activeClient?.history
	if (!h || typeof h.loadOlder !== 'function') return null
	try {
		return await h.loadOlder(convKey, cursor, viewport)
	} catch {
		// `cursor_invalid` and other failures: the caller reopens the conversation
		return null
	}
}

export const reportLocalChatLayout = async (
	convKey: string,
	stableId: string,
	viewport: ChatLocalViewport,
	wPt: number,
	hPt: number,
): Promise<boolean> => {
	const h = activeClient?.history
	if (!h || typeof h.reportLayout !== 'function') return false
	try {
		return (await h.reportLayout(convKey, stableId, viewport, wPt, hPt)).written
	} catch {
		return false
	}
}

export const clearLocalChatCache = async (
	scope: 'conversation' | 'account',
	convKey?: string,
): Promise<ChatLocalClearResult | null> => {
	const h = activeClient?.history
	if (!h || typeof h.clearLocalCache !== 'function') return null
	try {
		return await h.clearLocalCache(scope, convKey)
	} catch {
		return null
	}
}

export const syncLocalChatHistory = async (): Promise<boolean> => {
	const h = activeClient?.history
	if (!h || typeof h.syncLocal !== 'function') return false
	try {
		await h.syncLocal()
		return true
	} catch {
		return false
	}
}

export const migrateLocalChatHistory = async (
	extra: Array<{ peer: string; dir: 'in' | 'out'; ts: number; sendId?: string; body: string; pending?: boolean }>,
): Promise<{ verified: boolean; conversations: number } | null> => {
	const h = activeClient?.history
	if (!h || typeof h.migrateLocal !== 'function') return null
	try {
		return await h.migrateLocal(extra)
	} catch {
		return null
	}
}

/** Migration state of the library: none, running, complete, switched or purged. Null when unavailable. */
export const localChatMigrationState = async (): Promise<string | null> => {
	const h = activeClient?.history
	if (!h || typeof h.migrationState !== 'function') return null
	try {
		return await h.migrationState()
	} catch {
		return null
	}
}

/**switch the UI to the library. Null when unavailable; false when refused. */
export const switchLocalChatHistory = async (): Promise<boolean | null> => {
	const h = activeClient?.history
	if (!h || typeof h.switchLocal !== 'function') return null
	try {
		return await h.switchLocal()
	} catch {
		return null
	}
}

/**worker part: delete plaintext plain: keys. Null when unavailable (the caller treats it as a failure). */
export const purgeLocalChatPlain = async (): Promise<number | null> => {
	const h = activeClient?.history
	if (!h || typeof h.purgeLocalPlain !== 'function') return null
	try {
		return await h.purgeLocalPlain()
	} catch {
		return null
	}
}

/** Subkeys from the wallet layer (K_id, K_idx, DEK as hex). The worker never receives P or R_db. */
let pendingLocalUnlock: { kIdHex: string; kIdxHex: string; dekHex: string } | null = null

/**
 * Hand the subkeys to the worker. Before the worker client exists the keys are held here and flushed when it does;
 * the window event `beamio:chat-worker-ready` tells the page to continue (unlock, then migration).
 */
export const unlockLocalChatKeys = async (keys: { kIdHex: string; kIdxHex: string; dekHex: string }): Promise<boolean> => {
	const h = activeClient?.history
	if (!h || typeof h.unlockLocal !== 'function') {
		pendingLocalUnlock = keys
		return false
	}
	try {
		await h.unlockLocal(keys)
		return true
	} catch {
		return false
	}
}

/** Logout (D2): lock the library and zero the keys in the worker. */
export const lockLocalChat = async (): Promise<boolean> => {
	const h = activeClient?.history
	if (!h || typeof h.lockLocal !== 'function') return false
	try {
		await h.lockLocal()
		return true
	} catch {
		return false
	}
}

export const searchDecryptedChatHistory = async (
	query: string,
	options?: Omit<HistoryReadOptions, 'query'>,
): Promise<HistoryEntry[] | null> => {
	const text = query.trim()
	if (!text) return readDecryptedChatHistory(options)
	return readDecryptedChatHistory({ ...options, query: text })
}

/**
 * Fired once per worker client when it is ready to read (after init and the listen start). The page reads the full local corpus
 * on this signal, once per account and client (historyCorpusRead.ts). A load does not fire it.
 */
const workerReadyListeners = new Set<() => void>()
export const onWorkerReady = (cb: () => void): (() => void) => {
	workerReadyListeners.add(cb)
	return () => {
		workerReadyListeners.delete(cb)
	}
}

/**
 * Build the gossip Worker from the published `@conet.project/chat-sdk` package.
 * Webpack 5 (CRA/Craco) statically detects `new Worker(new URL(specifier,
 * import.meta.url))` and emits a classic worker chunk that loads openpgp/ethers
 * with `importScripts`. Module workers reject `importScripts`, so the chunk
 * never installs `onmessage` and voice listen times out. Keep this a classic
 * Worker (no `type: 'module'`).
 */
function makeGossipWorker(): Worker {
	// Shell build: the worker reference sits in a constant-false branch, so webpack emits no worker chunk.
	if (process.env.REACT_APP_SHELL_BUILD !== 'true') {
		// Belt-and-suspenders: native shells must never reach here.
		if (mustUseNativeChatBridge()) {
			throw new Error('chat-sdk Worker is disabled inside the native WebView shell')
		}
		return new Worker(new URL('../workers/chatSdkGossip/entry.ts', import.meta.url), {
			// Chunk name is the worker name. A new name bypasses a cached worker
			// that never finished opening the PGP key and left voice listen with no relay.
			name: 'beamio-chat-gossip-relay',
			type: 'classic',
		})
	}
	// Shell target: the Worker is compiled out. The comparison is a build-time constant, so webpack drops the Worker
	// and its chunk from the shell artifact (a runtime call to isShellBuildKind() would keep it).
	if (process.env.REACT_APP_SHELL_BUILD === 'true') {
		throw new Error('shell build: the TypeScript gossip Worker is not part of the shell target')
	}
	return new Worker(new URL('../workers/chatSdkGossip/entry.ts', import.meta.url), {
		// Chunk name is the worker name. A new name bypasses a cached worker
		// that never finished opening the PGP key and left voice listen with no relay.
		name: 'beamio-chat-gossip-relay',
		type: 'classic',
	})
}

export interface StartWorkerGossipParams {
	/** Own mailbox B route armored public key (encrypt listen to this). */
	ownRouteArmoredPublicKey: string
	/** The account EOA (checksummed). The account key is never passed to the worker. */
	eoaAddress: string
	/** Host signer: the worker asks for each account signature; the key stays with the host (2026-11-13). */
	signAccount: AccountSignFn
	/** Armored PGP private key (decrypts inbound in the worker). Browser build only; absent in the shell build. */
	pgpPrivateKeyArmored?: string
	/** Armored PGP public key (keyID / diagnostics). */
	pgpPublicKeyArmored: string
	/** Current healthy CoNET node snapshot (host owns discovery). */
	nodes: nodeInfo[]
	/** Session lifecycle signal; abort tears down the worker client. */
	rootSignal: AbortSignal
	/** Decrypted host-ready line → existing addNewMessage serial queue. */
	onLine: (line: string) => void
	onVoiceFrame?: (frame: VoiceFrame) => void
	onVoiceGap?: (event: VoiceGapEvent) => void
	onVoiceConflict?: (event: VoiceConflictEvent) => void
	/** Any inbound / liveness activity → refresh main-thread staleness timer. */
	onActivity: () => void
	/** Optional structured log sink (never logs key material / plaintext / ciphertext). */
	onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
}

/** Tear down the active worker listen client (idempotent). */
export const stopWorkerGossip = (): void => {
	if (activeClient) {
		try {
			activeClient.destroy()
		} catch {
			/* ignore */
		}
		activeClient = null
	}
	activeClientEoa = null
	activeFeatures = negotiateChatDaemon(null)
	voiceRelayOpen = null
	voiceRelayOpenSessionId = ''
}

/** True when a worker listen client is currently alive. */
export const isWorkerGossipActive = (): boolean => activeClient !== null

/**
 * Native shell: the Conet Chat Module owns the mailbox listen and reconnects it
 * itself. The page only pauses / resumes it and never tears it down to "resume";
 * the module defers a pause while a call rings or is up.
 */
export const isNativeChatListenOwner = (): boolean => activeClient !== null && activeClientIsNative

export const pauseNativeChatListen = (): boolean => {
	if (!isNativeChatListenOwner()) return false
	activeClient!.pause()
	return true
}

export const resumeNativeChatListen = (): boolean => {
	if (!isNativeChatListenOwner()) return false
	activeClient!.resume()
	return true
}

/**
 * Logout / wallet removal: the module stops and forgets the wallet and PGP keys
 * it keeps for call pushes. Call before the page drops the wallet.
 */
export const clearNativeChatIdentity = (): void => {
	clearNativeRouteState()
	// A module that negotiated without `identity.provision` stores no keys. With no
	// `hello` answer (or no running module) send it anyway: older modules ignore it.
	if (activeClientIsNative && !daemonAllows('identity.provision')) return
	// a valid reqId (the SDK answers a negative one with bad_request at its entry); nobody waits for the answer
	const cmd = { type: 'clearIdentity', reqId: 0 }
	try {
		const ios = (window as unknown as { CashTreesIOS?: { chatModuleCommand?: (p: Record<string, unknown>) => void } })
			.CashTreesIOS
		if (typeof ios?.chatModuleCommand === 'function') {
			ios.chatModuleCommand({ action: 'chatModuleCommand', command: cmd })
			return
		}
		// the Android path uses window.BeamioChat when present, else CashTreesAndroid.chatModuleCommand.
		postAndroidChatCommand(cmd)
	} catch {
		/* no shell */
	}
}

/** True while gossip init or a voice relay open must not be torn down. */
export const isWorkerGossipBusy = (): boolean =>
	workerInitPromise !== null || activeVoiceRelay !== null

/** Route public key the live worker encrypts voice_listen to. Empty when listen is down. */
export const getWorkerGossipRouteArmor = (): string => {
	if (!activeClient || !lastGossipParams || lastGossipParams.rootSignal.aborted) return ''
	return lastGossipParams.ownRouteArmoredPublicKey?.trim() || ''
}

/** Last listen parameters, including a session whose signal has already aborted. */
export const getWorkerGossipListenParams = (): StartWorkerGossipParams | null =>
	lastGossipParams

/**
 * an account the native layer refused with address_mismatch is not sent `init`again in this session (see
 * nativeInitRefusal.ts). A successful init, and a wallet event, clear the latch.
 */
const initLatch = createInitRefusalLatch()

/** The reason of the last listen start the native layer refused (read once by the caller). Null when the last start was not refused. */
export function takeListenRefusal(): string | null {
	return initLatch.takeRefusal()
}

/** the closed reason of the last listen start (`clear_failed`or `unregister_refused`), read once. Null otherwise. */
export function takeIdentityClosedRefusal(): IdentityClosedInitReason | null {
	return initLatch.takeIdentityClosed()
}

/** Clears the address_mismatch latch (wallet became ready). */
export function forgetInitRefusal(): void {
	initLatch.clear()
}

if (typeof window !== 'undefined') {
	for (const name of [BEAMIO_WALLET_READY_EVENT, NATIVE_WALLET_ESTABLISHED_EVENT]) window.addEventListener(name, forgetInitRefusal)
}

/**
 * Start the worker-based gossip LISTEN. Resolves true when the worker acknowledged
 * `init` (its internal `startListen()` then owns SSE connect/reconnect). Any prior
 * client is destroyed first (a new connection replaces the old).
 */
const startWorkerGossipListenInternal = async (p: StartWorkerGossipParams): Promise<boolean> => {
	lastGossipParams = p
	stopWorkerGossip()
	// a new client starts its own history loads (the gate does not cover them with the old client's loads).
	historyLoadGate.reset()
	if (p.rootSignal.aborted) return false
	if (initLatch.skipInit(p.eoaAddress)) {
		p.onLog?.('warn', 'init not sent: the native layer refused this account with address_mismatch; nothing is retried')
		return false
	}

	const eoaAddress = p.eoaAddress
	const nodeSnapshot = p.nodes.slice()

	// Native clients get public material only; the browser client adds its key inside the browser-only branch below.
	const config: NativeChatConfig = {
		identity: {
			eoaAddress,
			pgpPublicKeyArmored: p.pgpPublicKeyArmored,
			ownRouteArmoredPublicKey: p.ownRouteArmoredPublicKey,
		} as BeamioChatConfig['identity'],
		signAccount: p.signAccount,
		conetRpcUrl: CONET_RPC_URL,
		addressPgpContractAddress: CONET_ADDRESS_PGP,
		getNodes: async () => nodeSnapshot as unknown as NodeInfo[],
		ipfsBaseUrl: IPFS_BASE_URL,
		// On-chain encrypted-history head pointer: read via RPC getPointer(eoa); write via
		// EOA off-chain signature relayed (gasless) through the Cluster/Master. Enables
		// fresh-device recovery of chat history after account delete/restore.
		chatIndexRegistryAddress: CONET_CHAT_INDEX_REGISTRY,
		apiBaseUrl: BEAMIO_API_BASE_URL,
	}

	// Native WebView shells: Conet Chat Module owns LISTEN — never load chat-sdk Worker.
	// Prefer iOS shell first (1B hybrid signing); else Android; browser-only → TS Worker.
	const inNativeShell = mustUseNativeChatBridge()
	const useIosNative =
		preferIosNativeChatClient() || (inNativeShell && isCashTreesIosShell())
	const useAndroidNative =
		!useIosNative &&
		(preferAndroidNativeChatClient() ||
			(inNativeShell && !isCashTreesIosShell()))
	// Iron rule: shell present ⇒ native client only. Never call createBeamioChatClient.
	if (inNativeShell && !useIosNative && !useAndroidNative) {
		throw new Error('native WebView shell detected but no Conet Chat Module path resolved')
	}
	let client: ChatWorkerClient
	if (useIosNative) {
		client = createNativeConetChatClient(config)
		p.onLog?.('info', 'chat listen: iOS native Conet Chat Module (no TS Worker)')
	} else if (useAndroidNative) {
		client = createAndroidNativeChatClient(config)
		p.onLog?.('info', 'chat listen: Android native Conet Chat Module (no TS Worker)')
	} else {
		// Browser client only. Under the shell target the branch is compiled out (build-time constant), with its key handling.
		if (process.env.REACT_APP_SHELL_BUILD === 'true') {
			throw new Error('shell build: the TypeScript gossip client is not part of the shell target')
		} else {
			const browserConfig: BeamioChatConfig = {
				...config,
				identity: { ...config.identity, pgpPrivateKeyArmored: p.pgpPrivateKeyArmored ?? '', pgpPassphrase: '' },
			}
			client = createBeamioChatClient(browserConfig, { workerFactory: makeGossipWorker })
		}
		p.onLog?.('info', 'chat listen: TypeScript gossip Worker (browser)')
	}
	activeClient = client
	activeClientEoa = eoaAddress.toLowerCase()
	activeClientIsNative = useIosNative || useAndroidNative
	activeFeatures = negotiateChatDaemon(null)
	if (pendingLocalUnlock) {
		const held = pendingLocalUnlock
		pendingLocalUnlock = null
		void client.history.unlockLocal?.(held)?.catch?.(() => undefined)
	}

	const unsubs: Array<() => void> = []
	unsubs.push(
		client.on('message', (env) => {
			// a line belongs to the account of the client that decrypted it. A line of another account is not stored and not acked,
			// so the mailbox keeps it (the envelope has no recipient field: chat.ts sendMessage).
			const current = currentAccountGetter ? currentAccountGetter() : null
			const forThisAccount = !env.line || inboundLineForAccount(eoaAddress.toLowerCase(), current)
			if (env.line && forThisAccount && env.armorHash) {
				const set = pendingInboundAcks.get(env.line) ?? new Set<string>()
				set.add(env.armorHash)
				pendingInboundAcks.set(env.line, set)
				if (pendingInboundAcks.size > PENDING_INBOUND_ACK_MAX) {
					const oldest = pendingInboundAcks.keys().next().value
					if (oldest !== undefined) pendingInboundAcks.delete(oldest)
				}
			}
			if (env.line && forThisAccount) p.onLine(env.line)
			else if (env.line) p.onLog?.('warn', 'inbound line of another account not delivered (client bound to another account)')
			if (p.rootSignal.aborted) return
			p.onActivity()
		}),
	)
	unsubs.push(
		client.on('status', (st) => {
			// 'listening' is emitted on connect AND on every liveness/listing heartbeat →
			// keep the main-thread staleness timer fresh (parity with the old per-frame
			// noteGossipActivity()).
			if (st.status === 'listening') p.onActivity()
			p.onLog?.(
				'info',
				`${useIosNative || useAndroidNative ? 'native' : 'gossip'} status: ${st.status}${st.detail ? ` (${st.detail})` : ''}`,
			)
		}),
	)
	unsubs.push(
		client.on('log', (l) => {
			p.onLog?.(l.level, l.message)
		}),
	)
	unsubs.push(client.on('voiceFrame', (frame) => {
		for (const cb of voiceFrameListeners) {
			try { cb(frame) } catch { /* isolate voice UI listeners */ }
		}
		p.onVoiceFrame?.(frame)
	}))
	unsubs.push(client.on('voiceGap', (event) => {
		for (const cb of voiceGapListeners) {
			try { cb(event) } catch { /* isolate voice UI listeners */ }
		}
		p.onVoiceGap?.(event)
	}))
	unsubs.push(client.on('group', (event) => {
		for (const cb of groupInboundListeners) {
			try { cb(event) } catch { /* isolate group UI listeners */ }
		}
	}))
	unsubs.push(client.on('voiceConflict', (event) => {
		for (const cb of voiceConflictListeners) {
			try { cb(event) } catch { /* isolate voice UI listeners */ }
		}
		p.onVoiceConflict?.(event)
	}))
	// Fan encrypted-history restore/append batches to host subscribers (ChatList / chat page).
	unsubs.push(
		client.history.onBuffer((batch) => {
			if (p.rootSignal.aborted) return
			historyTail.noteTail(client, batch?.isTail)
			// Counted by the gate, then forwarded (historyLoadPath.deliverBuffer).
			historyLoadPath.deliverBuffer(batch, (b) => {
				// each batch carries the account of the client that produced it.
				const boundEoa = eoaAddress.toLowerCase()
				for (const cb of historyBufferListeners) {
					try {
						cb(b, boundEoa)
					} catch {
						/* ignore individual subscriber failure */
					}
				}
			})
		}),
	)

	const teardown = () => {
		for (const u of unsubs.splice(0)) {
			try {
				u()
			} catch {
				/* ignore */
			}
		}
		if (activeClient === client) {
			try {
				client.destroy()
			} catch {
				/* ignore */
			}
			activeClient = null
			activeClientEoa = null
		}
		p.rootSignal.removeEventListener('abort', teardown)
	}
	p.rootSignal.addEventListener('abort', teardown)

	try {
		// R79-watchdog: a start that never reaches the worker's ready is bounded and named (the step where it stopped)
		// (a native client has no worker start to bound: it is awaited as before)
		await (client.startStep !== undefined ? withWorkerReadyWatchdog(client.init(), () => client.startStep ?? '') : client.init())
		initLatch.noteReady()
		if (p.rootSignal.aborted) {
			teardown()
			return false
		}
		// The worker history exists now: local-library calls (unlock, migration) can be answered.
		if (typeof window !== 'undefined') window.dispatchEvent(new Event('beamio:chat-worker-ready'))
		// Protocol v1: decide by capability. Native clients already asked during
		// init; daemons before v1 answer null and keep the legacy rules.
		const features = negotiateChatDaemon(await client.hello().catch(() => null))
		if (activeClient === client) activeFeatures = features
		p.onLog?.(
			'info',
			features.status === 'negotiated'
				? `chat daemon: ${features.implementation || '?'} ${features.sdkVersion || '?'} protocol v${features.protocolVersion} caps=${features.capabilities.join(',')}`
				: `chat daemon: ${features.status} (no protocol v1 hello)`,
		)
		// Restore encrypted history once identity/RPC is ready (also flushes a load queued
		// before the client existed). iOS and Android native modules own historyLoad; the
		// native client waits for the module's history key before sending it. Old Android
		// shells without chatModuleCommand keep a no-op history stub.
		const transportLabel = useIosNative
			? 'iOS native'
			: useAndroidNative
				? 'Android native'
				: 'TS Worker'
		p.onLog?.('info', `chat history: ${transportLabel} worker ready — loading on-chain/IPFS index`)
		void loadWorkerHistory(undefined, consumeListenLoadCaller())
		for (const cb of workerReadyListeners) {
			try {
				cb()
			} catch {
				/* ignore individual subscriber failure */
			}
		}
		if (activeVoiceRelay) void openActiveVoiceRelay(activeVoiceRelay.sessionId)
		return true
	} catch (ex) {
		if (ex instanceof WorkerReadyTimeout) {
			// the stall is logged with its class and step only; the client is torn down so no half-started worker stays
			p.onLog?.('error', `chat worker not ready: class=${WORKER_READY_TIMEOUT} step=${ex.step}`)
			try {
				client.destroy()
			} catch {
				/* ignore */
			}
			if (activeClient === client) {
				activeClient = null
				activeClientEoa = null
			}
			return false
		}
		//the native restore answered a failure code; it is kept for the Chat route and never retried by the page.
		const restoreCode = (ex as Error)?.message
		if (isPgpRestoreFailure(restoreCode)) setPgpRestoreFailure(restoreCode)
		//refused, not failed. No retry and no lock or import page; the latch stops a repeated init.
		if (restoreCode) initLatch.noteRefusal(eoaAddress, restoreCode)
		// a closed module is reported to the start, which does not retry it automatically.
		initLatch.noteIdentityClosed(restoreCode ?? '')
		const failLabel = useIosNative
			? 'iOS native'
			: useAndroidNative
				? 'Android native'
				: 'worker'
		p.onLog?.(
			'error',
			`${failLabel} gossip init failed: ${(ex as Error)?.message ?? String(ex)}`,
		)
		teardown()
		return false
	}
}

export const startWorkerGossipListen = async (p: StartWorkerGossipParams): Promise<boolean> => {
	// Option A: no listen, and no key-derived client, in a shell without the chat capability.
	if (shellChatBlockedNow()) return false
	if (workerInitPromise) return workerInitPromise
	const promise = startWorkerGossipListenInternal(p)
	workerInitPromise = promise
	try {
		return await promise
	} finally {
		if (workerInitPromise === promise) workerInitPromise = null
	}
}

/**
 * Point an already-running listen at the current chain mailbox route.
 * Restarts the worker with the same session signal and node snapshot.
 */
export const retargetWorkerGossipRoute = async (
	ownRouteArmoredPublicKey: string,
	nodes?: StartWorkerGossipParams['nodes'],
): Promise<boolean> => {
	const prev = lastGossipParams
	const next = ownRouteArmoredPublicKey.trim()
	if (!prev || !next || prev.rootSignal.aborted) return false
	if (prev.ownRouteArmoredPublicKey === next && !nodes?.length) return true
	return startWorkerGossipListen({
		...prev,
		ownRouteArmoredPublicKey: next,
		nodes: nodes?.length ? nodes : prev.nodes,
	})
}

const wait = (ms: number) => new Promise<void>((resolve) => {
	setTimeout(resolve, ms)
})

const waitForVoiceWorker = async (): Promise<ChatWorkerClient | null> => {
	const deadline = Date.now() + 8_000
	while (Date.now() < deadline) {
		// The client is assigned before init() completes. Its postMessage queue
		// preserves init -> voiceListen ordering, so do not await a stale
		// workerInitPromise here; that promise can remain pending while the
		// worker is already able to process the queued relay command.
		if (activeClient) return activeClient
		const starting = workerInitPromise
		if (starting) await starting.catch(() => false)
		if (activeClient) return activeClient
		const retryParams = lastGossipParams
		if (retryParams && !retryParams.rootSignal.aborted && !workerInitPromise) {
			await startWorkerGossipListen(retryParams)
			if (activeClient) return activeClient
		}
		// An aborted session cannot be restarted from here. Spinning the full
		// deadline only delays the relay error; the caller restarts listen first.
		if (!activeClient && !workerInitPromise && (!retryParams || retryParams.rootSignal.aborted)) {
			return null
		}
		await wait(200)
	}
	return activeClient
}

const openActiveVoiceRelay = (sessionId: string): Promise<boolean> => {
	if (voiceRelayOpen && voiceRelayOpenSessionId === sessionId) return voiceRelayOpen
	const run = (async (): Promise<boolean> => {
		const relay = activeVoiceRelay
		if (!relay || relay.sessionId !== sessionId) {
			console.warn(`[voiceListen] relay missing before open session=${sessionId}`)
			return false
		}
		const client = await waitForVoiceWorker()
		if (!client) {
			console.warn(`[voiceListen] chat worker was not ready session=${sessionId}`)
			return false
		}
		if (activeVoiceRelay?.sessionId !== sessionId) {
			console.warn(`[voiceListen] relay replaced while the worker started session=${sessionId}`)
			return false
		}
		try {
			const started = await client.startVoiceListen(sessionId, relay.call)
			if (!started) console.warn('[voiceListen] worker refused to open the voice relay')
			if (started && activeVoiceRelay?.sessionId !== sessionId) {
				console.warn(`[voiceListen] relay cleared after the worker accepted session=${sessionId}`)
			}
			return started && activeVoiceRelay?.sessionId === sessionId
		} catch (ex) {
			console.warn('[voiceListen] worker error', (ex as Error)?.message ?? String(ex))
			return false
		}
	})()
	const tracked = run.finally(() => {
		if (voiceRelayOpen === tracked) {
			voiceRelayOpen = null
			voiceRelayOpenSessionId = ''
		}
	})
	voiceRelayOpen = tracked
	voiceRelayOpenSessionId = sessionId
	return tracked
}

/** The last v3 call's channels, kept across voice_unlisten for a same-session reconnect. */
let lastVoiceCall: { sessionId: string; call: VoiceCallV3Config } | null = null

export const startWorkerVoiceListen = async (
	sessionId: string,
	call?: VoiceCallV3Config,
): Promise<boolean> => {
	// A reconnect reopens the same session without the call: reuse its channels
	// (same temporary wallets, keys and relays), so the peer keeps sending there.
	if (!call && lastVoiceCall?.sessionId === sessionId) call = lastVoiceCall.call
	if (call) lastVoiceCall = { sessionId, call }
	activeVoiceRelay = { sessionId, call }
	const started = await openActiveVoiceRelay(sessionId)
	if (started) return true
	if (activeVoiceRelay?.sessionId !== sessionId) {
		console.warn('[voiceListen] session changed before the worker retry')
		return false
	}
	// One recovery. Restart only when the worker is actually gone. Restarting
	// a live worker aborts the handshake that is still opening.
	if (!isWorkerGossipActive()) {
		const prev = lastGossipParams
		if (prev && !prev.rootSignal.aborted) {
			console.warn('[voiceListen] restarting the chat worker before one more relay open')
			await startWorkerGossipListen(prev)
		}
	}
	if (activeVoiceRelay?.sessionId !== sessionId) return false
	return openActiveVoiceRelay(sessionId)
}

/** Post a signed command to the current wallet's own mailbox through the worker. */
export const postWorkerOwnMailboxCommand = async (
	command: Record<string, unknown>,
): Promise<boolean> => {
	if (!activeClient) return false
	try {
		return await activeClient.postOwnMailboxCommand(command)
	} catch {
		return false
	}
}

/** Browser dial: the offer to the callee mailbox (`voice_offer_store`, `push: 1`) through the worker. */
export const sendWorkerVoiceOffer = async (offer: VoiceOfferArgs): Promise<{ ok: boolean; pushed: boolean }> => {
	const client = await waitForVoiceWorker()
	if (!client?.sendVoiceOffer) return { ok: false, pushed: false }
	try {
		return await client.sendVoiceOffer(offer)
	} catch {
		return { ok: false, pushed: false }
	}
}

/** Forget the last call's channels (call over): no reconnect can reopen them. */
export const forgetWorkerVoiceCall = (sessionId: string): void => {
	if (lastVoiceCall?.sessionId === sessionId) lastVoiceCall = null
}

export const stopWorkerVoiceListen = async (sessionId: string): Promise<boolean> => {
	if (activeVoiceRelay?.sessionId === sessionId) activeVoiceRelay = null
	if (!activeClient) return false
	try {
		return await activeClient.stopVoiceListen(sessionId)
	} catch {
		return false
	}
}

export const sendWorkerVoiceFrame = async (
	routerArmoredPublicKey: string,
	frame: Record<string, unknown>,
): Promise<boolean> => {
	if (!activeClient) return false
	try {
		return await activeClient.sendVoiceFrame(routerArmoredPublicKey, frame)
	} catch {
		return false
	}
}


/** Signing is refused in the identity-only init: it sends no signed command. */
const refuseIdentityOnlySigning: AccountSignFn = async () => {
	throw new Error('native_signing_only')
}

/**
 * G1 start in a shell: init with the persisted public EOA only. The route and PGP public keys
 * are not sent and no listen starts. The platform choice is the same as the listen's.
 */
export async function initShellIdentityOnly(
	eoaAddress: string,
	nodes: NodeInfo[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const inNativeShell = mustUseNativeChatBridge()
	const useIosNative = preferIosNativeChatClient() || (inNativeShell && isCashTreesIosShell())
	const config: NativeChatConfig = {
		identity: {
			eoaAddress,
		},
		signAccount: refuseIdentityOnlySigning,
		conetRpcUrl: CONET_RPC_URL,
		addressPgpContractAddress: CONET_ADDRESS_PGP,
		getNodes: async () => nodes,
		ipfsBaseUrl: IPFS_BASE_URL,
		chatIndexRegistryAddress: CONET_CHAT_INDEX_REGISTRY,
		apiBaseUrl: BEAMIO_API_BASE_URL,
	}
	return useIosNative ? initNativeIdentityOnly(config) : initAndroidIdentityOnly(config)
}

/**
 * The automatic first open (plan step c): its own worker for the one command (the gossip client is not started at the key stage). The page
 * passes the encrypt-only sealing key and the public inputs; the worker answers the status and the key ID. The page never gets a key.
 */
export const runPageFirstOpen = (request: FirstOpenRequest, signAccount: (req: AccountSignRequest) => Promise<string>): Promise<FirstOpenResult> =>
	runFirstOpenInWorker(makeGossipWorker, request, signAccount)
