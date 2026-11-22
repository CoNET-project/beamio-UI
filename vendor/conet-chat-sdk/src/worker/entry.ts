/**
 * Worker entry — side-effectful. Import ONLY inside a Worker context
 * (`new Worker(new URL('.../worker/entry.js', import.meta.url), { type: 'module' })`).
 *
 * All openpgp encrypt/decrypt + ethers signing/verify-free hot paths live here so the
 * main thread stays responsive. Bridges {@link WorkerInbound} commands to {@link WorkerOutbound}
 * events via `postMessage`.
 */

import type { WorkerInbound, WorkerInitPayload, WorkerOutbound } from '../protocol.js'
import type { HistoryEntry, PresenceEvent, StatusEvent } from '../types.js'
import { tsWorkerHello } from '../daemon.js'
import { GossipCore } from './gossip-core.js'
import { HistoryStore } from './history.js'
import { createWorkerSignRelay } from './remote-sign.js'
import { createAccountSigning } from '../signer.js'
import type { WorkerSignRequest, WorkerSignResponse } from '../protocol.js'
import { generatePgpKeyPair } from '../firstOpen.js'
import { makeWorkerFirstOpenEnv, runFirstOpenCommand } from './first-open.js'

const ctx = globalThis as unknown as {
	postMessage: (msg: WorkerOutbound) => void
	onmessage: ((ev: MessageEvent<WorkerInbound>) => void) | null
	addEventListener: (t: string, cb: (ev: MessageEvent<WorkerInbound>) => void) => void
}

function post(msg: WorkerOutbound): void {
	ctx.postMessage(msg)
}

/** Account signatures are asked of the host (`signRequest`); the worker holds no account key. */
function postSignRequest(msg: WorkerSignRequest): void {
	ctx.postMessage(msg as unknown as WorkerOutbound)
}
const signRelay = createWorkerSignRelay(postSignRequest)

let gossip: GossipCore | null = null
let history: HistoryStore | null = null
let pendingLocalUnlock: { kIdHex: string; kIdxHex: string; dekHex: string } | null = null
/** Worker-local store for the first open (pending copy, refusal). IndexedDB in the browser. */
let firstOpenStore: ReturnType<typeof createWorkerPersistence> | null = null
let historySyncTimer: ReturnType<typeof setTimeout> | null = null

const HISTORY_SYNC_DELAY_MS = 30_000

function stopHistorySync(): void {
	if (historySyncTimer !== null) {
		clearTimeout(historySyncTimer)
		historySyncTimer = null
	}
}

function scheduleHistorySync(): void {
	stopHistorySync()
	historySyncTimer = setTimeout(async () => {
		historySyncTimer = null
		if (!history) return
		try {
			const changed = await history.syncFromHead()
			// Publish only bodies that were not already in the plaintext corpus.
			if (changed) await history.load({ localOnly: true, emit: 'fresh' })
		} catch (ex) {
			post({ type: 'event:log', level: 'warn', message: `history sync failed: ${(ex as Error)?.message ?? String(ex)}` })
		} finally {
			if (history) scheduleHistorySync()
		}
	}, HISTORY_SYNC_DELAY_MS)
}

function makeGossip(): GossipCore {
	return new GossipCore({
		message: (line, armorHash, plain, viaDomain) =>
			post({ type: 'event:message', payload: { line, armorHash, plain, viaDomain, receivedAt: Date.now() } }),
		group: (payload) => post({ type: 'event:group', payload }),
		voiceFrame: (payload) => post({ type: 'event:voiceFrame', payload }),
		voiceGap: (payload) => post({ type: 'event:voiceGap', payload }),
		voiceConflict: (payload) => post({ type: 'event:voiceConflict', payload }),
		status: (status: StatusEvent['status'], detail?: string) =>
			post({ type: 'event:status', payload: { status, detail } }),
		log: (level, message) => post({ type: 'event:log', level, message }),
		presence: (payload: PresenceEvent) => post({ type: 'event:presence', payload }),
	}, signRelay.request)
}

function makeHistory(payload: WorkerInitPayload): HistoryStore {
	return new HistoryStore(
		{
			buffer: (peer, entries, isTail) =>
				post({ type: 'event:historyBuffer', payload: { peer, entries, isTail } }),
			log: (level, message) => post({ type: 'event:log', level, message }),
		},
		{
			eoaAddress: payload.identity.eoaAddress,
			signing: createAccountSigning(payload.identity.eoaAddress, signRelay.request),
			chainId: payload.chainId,
			ipfsBaseUrl: payload.ipfsBaseUrl,
			ipfsWriteBaseUrl: payload.ipfsWriteBaseUrl,
			conetRpcUrl: payload.conetRpcUrl,
			chatIndexRegistryAddress: payload.chatIndexRegistryAddress,
			apiBaseUrl: payload.apiBaseUrl,
			// PersistenceAdapter cannot cross the worker boundary (functions aren't
			// clonable). The worker uses its own IndexedDB-backed adapter instead.
			persistence: createWorkerPersistence(),
		},
	)
}

/** IndexedDB persistence local to the worker (main-thread adapter can't be transferred). */
function createWorkerPersistence() {
	const DB_NAME = 'beamio-chat-sdk'
	const STORE = 'kv'
	let dbPromise: Promise<IDBDatabase> | null = null
	const open = (): Promise<IDBDatabase> => {
		if (dbPromise) return dbPromise
		dbPromise = new Promise((resolve, reject) => {
			const req = indexedDB.open(DB_NAME, 1)
			req.onupgradeneeded = () => {
				const db = req.result
				if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
			}
			req.onsuccess = () => resolve(req.result)
			req.onerror = () => reject(req.error)
		})
		return dbPromise
	}
	const tx = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> => {
		const db = await open()
		return new Promise<T>((resolve, reject) => {
			const t = db.transaction(STORE, mode)
			const store = t.objectStore(STORE)
			const req = fn(store)
			req.onsuccess = () => resolve(req.result as T)
			req.onerror = () => reject(req.error)
		})
	}
	return {
		async get(key: string) {
			try {
				return await tx<unknown>('readonly', (s) => s.get(key))
			} catch {
				return undefined
			}
		},
		async set(key: string, value: unknown) {
			try {
				await tx('readwrite', (s) => s.put(value, key))
			} catch {
				/* ignore */
			}
		},
		async delete(key: string) {
			try {
				await tx('readwrite', (s) => s.delete(key))
			} catch {
				/* ignore */
			}
		},
	}
}

async function handle(cmd: WorkerInbound): Promise<void> {
	switch (cmd.type) {
		case 'hello':
			post({ type: 'ack', reqId: cmd.reqId, ok: true, result: tsWorkerHello() })
			return
		case 'provisionIdentity':
		case 'clearIdentity':
			// Browser keys live only in this worker's memory (via `init`); no
			// `identity.provision` capability, so nothing is stored or cleared.
			if (cmd.reqId > 0) post({ type: 'ack', reqId: cmd.reqId, ok: false, error: 'unsupported_command' })
			return
		case 'ackInbound':
			// No `inbound.deferAck` capability: the page ACKs itself.
			return
		case 'init': {
			try {
				gossip = makeGossip()
				history = makeHistory(cmd.payload)
				if (pendingLocalUnlock) {
					history.unlockLocal(pendingLocalUnlock)
					pendingLocalUnlock = null
				}
				await gossip.init(cmd.payload)
				post({ type: 'ready', reqId: cmd.reqId })
				scheduleHistorySync()
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'setRoutes':
			gossip?.setRoutes(cmd.routes)
			return
		case 'setNodes':
			gossip?.setNodes(cmd.nodes)
			return
		case 'send': {
			try {
				const ok = await gossip!.send(cmd.to, cmd.payload, { beamioNoPush: cmd.beamioNoPush })
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result: { sent: ok, sendId: cmd.sendId } })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'sendGroup': {
			try {
				const result = await gossip!.sendGroup(cmd.request)
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'issueGroupRoster': {
			try {
				const result = await gossip!.issueGroupRoster(cmd.request)
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'issueGroupTombstone': {
			try {
				const result = await gossip!.issueGroupTombstone(cmd.request)
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'queryPresence': {
			try {
				const result = await gossip!.queryPresence(cmd.contacts)
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'queryNativeWake': {
			try {
				const result = await gossip!.queryNativeWake(cmd.contact)
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'historyLoad': {
			try {
				await history!.load(cmd.options)
				post({ type: 'ack', reqId: cmd.reqId, ok: true })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'historyRead': {
			try {
				const entries = await history!.read(cmd.options)
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result: entries })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'historyLocalOpen': {
			try {
				const page = await history!.openConversation(cmd.convKey, cmd.viewport)
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result: page })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'historyLocalLoadOlder': {
			try {
				const page = await history!.loadOlder(cmd.convKey, cmd.cursor, cmd.viewport)
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result: page })
			} catch (ex) {
				const code = (ex as { code?: string })?.code
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: code ?? ((ex as Error)?.message ?? String(ex)) })
			}
			return
		}
		case 'historyLocalReportLayout': {
			try {
				const out = await history!.reportLayout(cmd.convKey, cmd.stableId, cmd.viewport, cmd.wPt, cmd.hPt)
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result: out })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'historyLocalClear': {
			try {
				const out = await history!.clearLocalCache(cmd.scope, cmd.convKey)
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result: out })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'historyLocalSync': {
			try {
				await history!.syncLocal()
				post({ type: 'ack', reqId: cmd.reqId, ok: true })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'historyLocalMigrate': {
			try {
				const out = await history!.migrateLocal(cmd.extra)
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result: out })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'historyLocalMigrationState': {
			try {
				const state = await history!.localMigrationState()
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result: state })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'historyLocalSwitch': {
			try {
				const ok = await history!.switchLocal()
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result: ok })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'historyLocalPurge': {
			try {
				const removed = await history!.purgePlainKeys()
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result: removed })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'historyLocalUnlock': {
			try {
				const keys = { kIdHex: cmd.kIdHex, kIdxHex: cmd.kIdxHex, dekHex: cmd.dekHex }
				// The wallet layer may unlock before init created the history object: hold the keys until then.
				if (history) history.unlockLocal(keys)
				else pendingLocalUnlock = keys
				post({ type: 'ack', reqId: cmd.reqId, ok: true })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'historyLocalLock': {
			try {
				history?.lockLocal()
				post({ type: 'ack', reqId: cmd.reqId, ok: true })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'historyAppend': {
			try {
				await history!.append(cmd.entry as Omit<HistoryEntry, 'seq'>)
				post({ type: 'ack', reqId: cmd.reqId, ok: true })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'mailboxCommand': {
			try {
				const ok = await gossip!.postMailboxCommand(cmd.routerArmoredPublicKey, cmd.command)
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result: { sent: ok } })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'ownMailboxCommand': {
			try {
				const ok = await gossip!.postOwnMailboxCommand(cmd.command)
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result: { sent: ok } })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'firstOpen': {
			try {
				firstOpenStore = firstOpenStore ?? createWorkerPersistence()
				const req = cmd.request
				const env = makeWorkerFirstOpenEnv({
					conetRpcUrl: req.conetRpcUrl,
					chainId: req.chainId,
					pgpManagerAddress: req.pgpManagerAddress,
					apiBaseUrl: req.apiBaseUrl,
					sealKey: req.sealKey,
					store: firstOpenStore,
					signMessage: (message) => createAccountSigning(req.eoa, signRelay.request).signMessage(message),
					generateKeys: (eoa) => generatePgpKeyPair(eoa),
				})
				const result = await runFirstOpenCommand(req, env)
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'voiceFrame': {
			try {
				const ok = await gossip!.sendVoiceFrame(cmd.routerArmoredPublicKey, cmd.frame)
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result: { sent: ok } })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'voiceListen': {
			try {
				const ok = await gossip!.startVoiceListen(cmd.sessionId, cmd.call)
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result: { started: ok } })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'voiceOffer': {
			try {
				const result = await gossip!.sendVoiceOffer(cmd.offer)
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'voiceUnlisten': {
			try {
				const ok = await gossip!.stopVoiceListen(cmd.sessionId)
				post({ type: 'ack', reqId: cmd.reqId, ok: true, result: { stopped: ok } })
			} catch (ex) {
				post({ type: 'ack', reqId: cmd.reqId, ok: false, error: (ex as Error)?.message ?? String(ex) })
			}
			return
		}
		case 'pause':
			gossip?.pause()
			return
		case 'resume':
			gossip?.resume()
			return
		case 'destroy':
			stopHistorySync()
			gossip?.destroy()
			history?.destroy()
			gossip = null
			history = null
			return
		case 'nodesResponse':
			if (cmd.nodes?.length) gossip?.setNodes(cmd.nodes)
			return
		default: {
			const unknown = cmd as { reqId?: unknown }
			if (typeof unknown.reqId === 'number' && unknown.reqId > 0) {
				post({ type: 'ack', reqId: unknown.reqId, ok: false, error: 'unknown_command' })
			}
			return
		}
	}
}

/**
 * Starts the worker: attaches the message listener. The host calls this once from its worker wrapper. Importing this module has no
 * side effect, so a bundler with `sideEffects: false` cannot drop the listener: the start is an explicit call, not an import.
 */
export function startChatWorkerEntry(): void {
	ctx.addEventListener('message', (ev: MessageEvent<WorkerInbound>) => {
		const data = ev.data as unknown as { type?: unknown }
		if (data && data.type === 'signResponse') {
			signRelay.onResponse(ev.data as unknown as WorkerSignResponse)
			return
		}
		void handle(ev.data)
	})
}
