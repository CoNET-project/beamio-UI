/**
 * a test-only hook so QA can make the receipts of two sends arrive OUT OF ORDER (case c: the second message of a conversation is acknowledged before the first).
 *
 * COMPILE-TIME SWITCH: everything here sits behind `QA_ACK_ORDER_HOOK`, which is `process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true'`. webpack's DefinePlugin (craco.config.js) replaces that
 * expression with the literal "false" in every build that is not built with REACT_APP_QA_ACK_ORDER_HOOK=true, and the minifier then removes the branches: the production main JS contains neither the
 * hook's global name nor its other text. No URL parameter, local storage value, global variable or remote configuration can turn it on: there is no code in a production bundle that reads them.
 *
 * How to turn it on (a QA build only): `REACT_APP_QA_ACK_ORDER_HOOK=true` in the environment of the build (build:react). Then in the page:
 *   window.__beamioQaAckOrder.holdNext(n) the receipt handling of the next n sends is held (their queue settle waits)
 *   window.__beamioQaAckOrder.release(sendId?) release one held send (or all when no id is given): the order of the calls is the order the receipts "arrive"
 *   window.__beamioQaAckOrder.held the sendIds that are held now
 */
import { chatWriteLockState } from '@/services/chatWriteLock'
import { receiptTrace } from '@/services/deliveryReceiptBus'
import { receiptHoldStatsSnapshot } from '@/services/receiptHold'
import { rxSnapshot } from '@/services/receiveCounters'
import { qaFaultHits, qaFaultMode } from '@/services/qaTransportFault'
import { qaFirstCopySourceOf } from '@/utils/qaCopySource'
import { qaClearPlainCacheForOwner } from '@/utils/qaPlainCache'

export const QA_ACK_ORDER_HOOK = process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true'

/**
 * Read-only state export for QA (same compile-time switch, so it is folded away in every other build): window.__beamioQaAckOrder.state resolves to
 *   { chats: [{ peer: <last 6 of the contact address>, messages: [{ sendId, status, from, createdAt }] }], queue: [{ sendId, state, attempts }], queueDocs: [sendId], lock: {counters} }
 * Only those fields. No message text, no ciphertext, no digest, no key: every probe's output is copied field by field through the whitelist below, so an extra field in a probe never leaves.
 */
type ChatsProbe = () => Array<{ address?: string; messages?: Array<Record<string, unknown>> }>
type QueueProbe = () => Array<{ sendId: string; state: string; attempts: number } & Record<string, unknown>>
type DocsProbe = () => Promise<string[]>
/** the last kicks of the open conversation's send queue: when, why (load / online / visible / timer / manual / heartbeat), what the page believed about the network, how many attempts it started */
type KicksProbe = () => Array<{ at: number; trigger: string; online: boolean; started: number }>
/** the open conversation as the page shows it (in library mode the account record holds no bodies, so this is the view that matters for the sender's copy) */
/** the persistence rule of the account as the page applies it (chatLocalPurge.ts libraryPersistExplain): the mode and what it was decided from; registered by the App, so it exists before any conversation is mounted */
type PersistProbe = () => { mode?: string; flag?: boolean; capable?: boolean | null; state?: string | null; evidence?: string }
type ConversationProbe = () => { address?: string; messages?: Array<Record<string, unknown>>; libraryAcked?: string[]; libraryMode?: boolean | null; purgedFlag?: boolean | null; libraryState?: string | null; persistMode?: string; capable?: boolean; mountAt?: number; seen?: Record<string, number>; libraryRead?: string } | null
const probes: { chats?: ChatsProbe; queue?: QueueProbe; docs?: DocsProbe; conversation?: ConversationProbe; kicks?: KicksProbe; persist?: PersistProbe } = {}

export function qaRegisterProbe(kind: 'chats', fn: ChatsProbe | null): void
export function qaRegisterProbe(kind: 'queue', fn: QueueProbe | null): void
export function qaRegisterProbe(kind: 'docs', fn: DocsProbe | null): void
export function qaRegisterProbe(kind: 'conversation', fn: ConversationProbe | null): void
export function qaRegisterProbe(kind: 'kicks', fn: KicksProbe | null): void
export function qaRegisterProbe(kind: 'persist', fn: PersistProbe | null): void
export function qaRegisterProbe(kind: 'chats' | 'queue' | 'docs' | 'conversation' | 'kicks' | 'persist', fn: ChatsProbe | QueueProbe | DocsProbe | ConversationProbe | KicksProbe | PersistProbe | null): void {
	if (process.env.REACT_APP_QA_ACK_ORDER_HOOK !== 'true') return
	if (fn === null) delete probes[kind]
	else (probes as Record<string, unknown>)[kind] = fn
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
/** an error CODE only (lower case letters, digits, underscore, at most 40): never a sentence, a text or a key */
const code = (v: unknown): string => (typeof v === 'string' && /^[a-z0-9_]{1,40}$/.test(v) ? v : '')

/** The sanitized state (exported for the tests; the page reaches it only through the hook). */
/** how many times the queue-document listing failed (hook variant only; a failure is not the same as an empty list) */
let qaDocsErrors = 0
/** the account-level persistence rule, sanitised: plain words and booleans only; `unregistered` before the App has registered the probe (it registers at mount, before any conversation) */
export function qaPersistExport() {
	const p = probes.persist?.()
	if (!p) return { mode: 'unregistered', flag: null as boolean | null, capable: null as boolean | null, state: null as string | null, evidence: null as string | null }
	return {
		mode: code(p.mode) || null,
		flag: typeof p.flag === 'boolean' ? p.flag : null,
		capable: typeof p.capable === 'boolean' ? p.capable : null,
		state: code(p.state) || null,
		evidence: code(p.evidence) || null,
	}
}
export async function qaExportState() {
	const chats = (probes.chats?.() ?? []).map((c) => ({
		peer: str(c.address).toLowerCase().slice(-6),
		messages: (Array.isArray(c.messages) ? c.messages : []).map((m) => ({ sendId: str(m.sendId), status: str(m.status), from: str(m.from), createdAt: num(m.createdAt) })),
	}))
	const conv = probes.conversation?.() ?? null
	const convProbe: 'registered' | 'unregistered' = conv ? 'registered' : 'unregistered'
	const conversation = conv
		? {
			peer: str(conv.address).toLowerCase().slice(-6),
			messages: (Array.isArray(conv.messages) ? conv.messages : []).map((m) => ({ sendId: str(m.sendId), status: str(m.status), from: str(m.from), createdAt: num(m.createdAt), sendError: code(m.sendError) })),
			libraryAcked: (Array.isArray(conv.libraryAcked) ? conv.libraryAcked : []).map(str),
			libraryMode: typeof conv.libraryMode === 'boolean' ? conv.libraryMode : null,
			// what the library-mode decision was made from: the localStorage flag (lost at a SIGKILL) and the library's own migration state (a plain word: none, running, complete, switched, purged)
			purgedFlag: typeof conv.purgedFlag === 'boolean' ? conv.purgedFlag : null,
			libraryState: code(conv.libraryState) || null,
			// the CURRENT persistence rule (libraryPersistModeFor: library / guarded / record) and whether the client has a library, read live when the state is exported (not the cache of the last decision)
			persistMode: code(conv.persistMode) || null,
			capable: typeof conv.capable === 'boolean' ? conv.capable : null,
			mountAt: num(conv.mountAt),
			seen: Object.fromEntries(Object.entries(conv.seen ?? {}).slice(0, 40).map(([k, v]) => [str(k).slice(-8), num(v)])),
			libraryRead: code(conv.libraryRead) || null,
			// where the first copy shown after the mount came from (plain words: record, queue, library, app_history, joined with _, or unknown); null while no copy has been classified yet
			firstCopySource: qaFirstCopySourceOf(str(conv.address)),
		}
		: null
	const rawQueue = probes.queue?.() ?? []
	const queue = rawQueue.map((q) => ({ sendId: str(q.sendId), state: str(q.state), attempts: num(q.attempts), confirmedSince: num(q.confirmedSince), lastAttemptAt: num(q.lastAttemptAt) }))
	// confirmed (proof seen) but the copy is not durable yet: how many, and how long the oldest has been so (the backup notice runs on it)
	const confirmedSinceList = queue.filter((q) => q.state === 'confirmed' && q.confirmedSince > 0).map((q) => q.confirmedSince)
	const confirmedUnbacked = { count: confirmedSinceList.length, oldestAgeMs: confirmedSinceList.length ? Math.max(0, Date.now() - Math.min(...confirmedSinceList)) : 0 }
	const kicks = (probes.kicks?.() ?? []).map((k) => ({ at: num(k.at), trigger: code(k.trigger), online: k.online === true, started: num(k.started) }))
	let docs: string[] = []
	try { docs = (await probes.docs?.()) ?? [] } catch { docs = []; qaDocsErrors += 1 } // a failing document listing is COUNTED (it is not the same as "no documents")
	const queueDocs = docs.map((d) => str(d).split(':').pop() as string)
	const lock = chatWriteLockState() as unknown as Record<string, number | boolean>
	const events = qaEventList().map((e) => ({ at: num(e.at), n: code(e.n), id: str(e.id).slice(-8), dt: num(e.dt), x: code(e.x) }))
	const receipts = receiptTrace().map((r) => ({ at: num(r.at), id: str(r.id).slice(-8), from: str(r.from).slice(-6), outcome: code(r.outcome) }))
	// counters only (receiptHold.ts): how many receipt lines were held and why, and how many receipts were written because a queue document stayed unreadable. No id, no tag, no address.
	const rh = receiptHoldStatsSnapshot()
	const receiptHold = { held: num(rh.held), noKey: num(rh.heldNoKey), unreadable: num(rh.heldUnreadable), disk: num(rh.heldDisk), permanent: num(rh.permanent), permanentActive: num(rh.permanentActive) }
	// the receiving side (receiveCounters.ts): per id and in total, numbers only, ids cut to 8 characters
	const rxs = rxSnapshot()
	const receiveCounters = { totals: Object.fromEntries(Object.entries(rxs.totals).map(([k, v]) => [code(k), num(v)])), ids: rxs.ids.slice(-12).map((r) => ({ id: str(r.id).slice(-8), arr: num(r.arr), dd: num(r.dd), ra: num(r.ra), re: num(r.re), ro: num(r.ro), rf: num(r.rf), rk: num(r.rk), rn: num(r.rn) })) }
	// the simulated transport fault (qaTransportFault.ts): the mode and how many sends it failed
	const transportFault = { mode: code(qaFaultMode()), hits: num(qaFaultHits()) }
	// the persistence rule of an UNREGISTERED conversation probe is not `null` (that means "registered but silent"): it is the word `unregistered`
	const conversationPersist = { probe: convProbe, mode: conv ? (code(conv.persistMode) || null) : 'unregistered' }
	const persist = qaPersistExport()
	return { chats, conversation, conversationPersist, persist, queue, queueDocs, docsErrors: num(qaDocsErrors), lock, kicks, confirmedUnbacked, receipts, events, receiptHold, receiveCounters, transportFault }
}

/**
 * a read that needs no debugger. WebView debugging (CDP) runs over a socket protocol that the product rules forbid, so the hook variant PRINTS its state: one `console.info` line every 5 s with a fixed tag,
 * a whitelisted compact JSON (queue states and times, the last kicks, confirmed-but-unbacked, the conversation's library evidence and send-error codes). Both shells already forward the page console to their
 * own log (Android: logcat tag `PWA-JS`; iOS Debug / BEAMIO_QA builds: unified log subsystem com.beamio.beamio, category PWA-JS), so no native code changes. Compile-time switch only: the production bundle
 * contains neither this function nor the tag. No text, ciphertext, digest or full address: ids are cut to their last 8 characters, the peer to its last 6, error fields are plain codes.
 */
/**
 * the event stream of the hook variant, each entry with its millisecond timestamp: app_start (the page's time origin), network_up / network_down (the page's own online / offline events), click,
 * queue_doc_landed and accepted (the send of one sendId; `dt` = ms since the click), native_chat_ready (the entry nodes arrived), attempt_start (a queue attempt), post_answer / post_failed (the POST was answered),
 * kick (a queue kick, detail = its trigger). Codes only; ids cut to 8 characters. Compile-time switch: nothing here exists in a production build.
 */
export interface QaEvent { at: number; n: string; id?: string; dt?: number; x?: string }
const qaEvents: QaEvent[] = []
const qaClickAt = new Map<string, number>()
let qaLastClickAt = 0
export function qaEvent(name: string, id?: string, detail?: string): void {
	if (process.env.REACT_APP_QA_ACK_ORDER_HOOK !== 'true') return
	const at = Date.now()
	const n = String(name).replace(/[^a-z_]/g, '').slice(0, 32)
	const e: QaEvent = { at, n }
	if (id) e.id = String(id).slice(-8)
	if (detail) e.x = String(detail).replace(/[^a-z0-9_]/g, '').slice(0, 24) // plain code words and numbers (the plaintext key count, the clear's numbers)
	if (n === 'click') qaLastClickAt = at
	else if ((n === 'queue_doc_landed' || n === 'accepted') && qaLastClickAt) e.dt = at - qaLastClickAt
	qaEvents.push(e)
	if (qaEvents.length > 120) qaEvents.shift()
	void qaClickAt
}
export const qaEventList = (): QaEvent[] => (process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true' ? [...qaEvents] : [])

export const QA_STATE_LINE_TAG = '[QA-STATE]'
const QA_LINE_MAX_BYTES = 2800 // a logcat entry holds about 4000 bytes; the line stays well inside
export function qaStateLine(state: Awaited<ReturnType<typeof qaExportState>>, now: number): string {
	const tail = (s: string) => s.slice(-8)
	const build = (queueCap: number, msgCap: number, kickCap: number) => ({
		t: now,
		q: state.queue.slice(0, queueCap).map((q) => ({ id: tail(q.sendId), s: q.state, a: q.attempts, cs: q.confirmedSince, la: q.lastAttemptAt })),
		k: state.kicks.slice(-kickCap).map((k) => ({ at: k.at, tr: k.trigger, on: k.online ? 1 : 0, n: k.started })),
		cu: state.confirmedUnbacked,
		ev: state.events.slice(-14).map((e) => ({ at: e.at, n: e.n, ...(e.id ? { id: e.id } : {}), ...(e.dt ? { dt: e.dt } : {}), ...(e.x ? { x: e.x } : {}) })),
		rc: state.receipts.slice(-8).map((r) => ({ at: r.at, id: r.id, f: r.from, o: r.outcome })),
		qd: state.queueDocs.length,
		qn: state.queue.length,
		de: state.docsErrors,
		ft: { m: state.transportFault.mode, n: state.transportFault.hits },
		rx: { t: state.receiveCounters.totals, i: state.receiveCounters.ids.slice(-Math.max(2, Math.ceil(msgCap / 5))) },
		rh: { h: state.receiptHold.held, k: state.receiptHold.noKey, u: state.receiptHold.unreadable, d: state.receiptHold.disk, p: state.receiptHold.permanent, pa: state.receiptHold.permanentActive },
		lk: { w: state.lock.writing ? 1 : 0, u: Number(state.lock.unsaved) || 0, q: Number(state.lock.queued) || 0, aw: Number(state.lock.awaiting) || 0, d: Number(state.lock.dirtyDrafts) || 0, f: Number(state.lock.inFlight) || 0, h: state.lock.heldReload ? 1 : 0 },
		pp: state.persist ? { m: state.persist.mode, f: state.persist.flag, c: state.persist.capable, s: state.persist.state, e: state.persist.evidence } : undefined, // the account-level persistence rule and its evidence (readable before a conversation is mounted)
		c: state.conversation
			? { peer: state.conversation.peer, ma: state.conversation.mountAt, sn: state.conversation.seen, lr: state.conversation.libraryRead, lm: state.conversation.libraryMode, pf: state.conversation.purgedFlag, ls: state.conversation.libraryState, pm: state.conversation.persistMode, cp: state.conversation.capable, cs: state.conversation.firstCopySource, ack: state.conversation.libraryAcked.slice(0, msgCap).map(tail), m: state.conversation.messages.slice(-msgCap).map((m) => ({ id: tail(m.sendId), s: m.status, e: m.sendError })) }
			: { pm: state.conversationPersist?.mode ?? 'unregistered' }, // no conversation probe: the persistence rule is the word `unregistered` (never null)
	})
	let line = ''
	const steps: Array<[number, number, number]> = [[20, 30, 8], [10, 15, 5], [5, 6, 3], [3, 3, 2]]
	for (const [queueCap, msgCap, kickCap] of steps) {
		line = `${QA_STATE_LINE_TAG} ${JSON.stringify(build(queueCap, msgCap, kickCap))}`
		if (line.length <= QA_LINE_MAX_BYTES) break
	}
	return line.slice(0, QA_LINE_MAX_BYTES)
}

/**
 * Where the line goes. `console.*` is NOT enough: the production build strips every console call (craco.config.js terser `drop_console: true`), the hook variant included, so a console.info alone would never print.
 * The shells' own debug-log channel is a bridge call and survives: Android `CashTreesAndroid.debugLog` -> CashTreesWebConsoleRelay -> logcat tag `PWA-JS`; iOS `CashTreesIOS.debugLog` -> the same relay -> unified log
 * (subsystem com.beamio.beamio, category PWA-JS; Debug and BEAMIO_QA builds only). The console call stays for a browser build that is not minified (dev, tests).
 */
export function qaEmitStateLine(line: string): void {
	try {
		const w = window as unknown as { CashTreesIOS?: { debugLog?: (l: string, t: string) => void }; CashTreesAndroid?: { debugLog?: (l: string, t: string) => void } }
		if (typeof w.CashTreesIOS?.debugLog === 'function') w.CashTreesIOS.debugLog('info', line)
		else if (typeof w.CashTreesAndroid?.debugLog === 'function') w.CashTreesAndroid.debugLog('info', line)
	} catch {
		// diagnostics only
	}
	console.info(line)
}

type Held = { sendId: string; release: () => void }

let holdLeft = 0
const heldList: Held[] = []

/** Awaited by the send path after the entry answered and before the receipt is acted on. Without the hook it returns at once. */
export async function qaHoldAck(sendId: string): Promise<void> {
	if (process.env.REACT_APP_QA_ACK_ORDER_HOOK !== 'true') return
	if (holdLeft <= 0) return
	holdLeft -= 1
	await new Promise<void>((resolve) => {
		heldList.push({ sendId, release: resolve })
	})
}

if (process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && typeof window !== 'undefined') {
	;(window as unknown as Record<string, unknown>).__beamioQaAckOrder = {
		holdNext: (n: number) => { holdLeft = Math.max(0, Math.floor(Number(n) || 0)) },
		release: (sendId?: string) => {
			for (const h of [...heldList]) {
				if (sendId && h.sendId !== sendId) continue
				heldList.splice(heldList.indexOf(h), 1)
				h.release()
			}
		},
		held: () => heldList.map((h) => h.sendId),
		state: () => qaExportState(),
		// the QA control round of the first-copy question: only the plaintext history-cache keys of this account are deleted (numbers before and after come back)
		// the account-level persistence rule and what it was decided from (read-only; readable before any conversation is mounted)
		persistMode: () => qaPersistExport(),
		clearPlainCache: () => qaClearPlainCacheForOwner((n, d) => qaEvent(n, undefined, d)),
	}
	qaEvent('app_start')
	{ const origin = typeof performance !== 'undefined' ? Math.round(Number(performance.timeOrigin)) : NaN; if (Number.isFinite(origin) && origin > 0) qaEvents[0].at = origin } // the page's own start
	window.addEventListener('online', () => qaEvent('network_up'))
	window.addEventListener('offline', () => qaEvent('network_down'))
	// the state printed every 5 s (qaStateLine); an interval that cannot run or a failed export prints nothing and never throws into the page
	window.setInterval(() => {
		void qaExportState().then((st) => qaEmitStateLine(qaStateLine(st, Date.now()))).catch(() => undefined)
	}, 5000)
}
