/**
 * the wiring of the history load. The bridge no longer reads the whole history back after a load and notifies the
 * listeners (the replay); the buffer still delivers the new entries to the page; the page still reads the history once at mount;
 * the load follows the account, not the gossip flips; a foreground resume is reported to the bridge. These are source checks, because
 * the bridge cannot be loaded under jest (the worker import). The gate's behaviour is tested run-time in historyLoadGate.test.ts.
 * SYNTHETIC values only.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '..')
const bridge = fs.readFileSync(path.join(__dirname, 'chatWorkerBridge.ts'), 'utf8')
const app = fs.readFileSync(path.join(SRC, 'App.tsx'), 'utf8')
const chat = fs.readFileSync(path.join(__dirname, 'chat.ts'), 'utf8')

/** The text of one exported function, from its first line to its closing brace at the same indentation. */
function fn(src: string, start: string): string {
	const at = src.indexOf(start)
	if (at < 0) return ''
	const open = src.indexOf('{', src.indexOf('=>', at) >= 0 && src.indexOf('=>', at) < src.indexOf('{', at + start.length) ? src.indexOf('=>', at) : at)
	let depth = 0
	for (let i = open; i < src.length; i += 1) {
		if (src[i] === '{') depth += 1
		if (src[i] === '}') {
			depth -= 1
			if (depth === 0) return src.slice(at, i + 1)
		}
	}
	return ''
}

describe('the load does not replay the history after it runs', () => {
	const loadFn = fn(bridge, 'export const loadWorkerHistory = async (')

	it('loadWorkerHistory reads nothing back and notifies no listener after the load', () => {
		expect(loadFn).not.toBe('')
		expect(loadFn).not.toContain('readDecryptedChatHistory')
		expect(loadFn).not.toContain('decryptedHistoryListeners')
		// the queue and the gate live in historyLoadPath.ts (run-time tests there); the bridge only passes the client state.
		expect(loadFn).toContain('await historyLoadPath.load(options, caller, activeClient !== null)')
		expect(bridge).not.toMatch(/let pendingHistoryLoad/)
	})

	it('the bridge creates the load path with the gate and the SDK load, and nothing else holds a queue', () => {
		expect(bridge).toContain("import { createHistoryLoadPath } from './historyLoadPath'")
		expect(bridge).toMatch(/createHistoryLoadPath<HistoryLoadOptions>\(\{\s*gate: historyLoadGate,\s*runLoad: runHistoryLoad,/)
	})

	it('the decrypted-history listeners are no longer fed by a load', () => {
		expect(bridge).not.toMatch(/for \(const cb of decryptedHistoryListeners\)/)
	})
})

describe('the new entries still reach the page through the history buffer', () => {
	it('the bridge counts the buffer deliveries and forwards each batch to the history buffer listeners', () => {
		const at = bridge.indexOf('client.history.onBuffer((batch) => {')
		expect(at).toBeGreaterThan(0)
		const handler = bridge.slice(at, at + 700)
		// The count is in deliverBuffer (historyLoadPath.ts counts, then forwards the same batch; run-time tested there).
		expect(handler).toContain('historyLoadPath.deliverBuffer(batch, (b) => {')
		expect(handler.indexOf('historyLoadPath.deliverBuffer(')).toBeLessThan(handler.indexOf('for (const cb of historyBufferListeners)'))
		expect(handler).toContain('cb(b, boundEoa)')
	})

	it('the app applies every buffer batch', () => {
		// a batch from a client bound to another account is dropped before it is applied (historyClientBinding.ts).
		expect(app).toContain('const unsub = onHistoryBuffer((batch, boundEoa) => {')
		expect(app).toContain('if (!shouldApplyBufferBatch(boundEoa, historyAccountNow())) return')
		expect(app).toContain('applyEntries(batch?.entries || [])')
	})
})

describe('the page reads the full corpus through the scheduler, not after a load', () => {
	it('the mount read is gone; the scheduler reads once the account, key and worker are ready, and applies the entries', () => {
		expect(app).not.toContain('void readDecryptedChatHistory().then(')
		expect(app).toContain('createCorpusReadScheduler({')
		expect(app).toContain('read: () => readDecryptedChatHistory(),')
		expect(app).toContain('if (historyAccountNow() === account) applyEntriesRef.current?.(entries)')
		expect(app).toContain('boundAccount: () => boundAccountOfActiveClient(),')
		expect(app).toContain('onReset: () => restoredHistoryKeysRef.current.clear(),')
		expect(app).toContain('corpusReadRef.current?.sync({')
		expect(app).toContain('corpusReadRef.current?.sync({')
		expect(app).toContain('const account = corpusAccountOf(profiles?.[0])')
		expect(app).toContain('account,')
		// the same epoch bump, plus the hook-only event and the library-evidence refresh on a ready worker
		expect(app).toContain('useEffect(() => onWorkerReady(() => { setWorkerEpoch((n) => n + 1); if (process.env.REACT_APP_QA_ACK_ORDER_HOOK === \'true\') qaEvent(\'chat_worker_ready\'); void refreshEvidenceOnWorkerReady() }), [])')
	})

	it('the dead decrypted-history listener is gone from the app and the bridge', () => {
		expect(app).not.toContain('onDecryptedChatHistory')
		expect(bridge).not.toContain('onDecryptedChatHistory')
		expect(bridge).not.toContain('decryptedHistoryListeners')
	})

	it('the bridge signals the worker ready once per client, after the listen start load is requested', () => {
		const at = bridge.indexOf('void loadWorkerHistory(undefined, consumeListenLoadCaller())')
		expect(at).toBeGreaterThan(0)
		expect(bridge.slice(at, at + 300)).toContain('for (const cb of workerReadyListeners)')
	})
})

describe('the load follows the account, not the gossip flips', () => {
	it('the historyEoa effect depends on the account only and does not load on a gossip flip', () => {
		expect(app).toContain("void loadWorkerHistory(undefined, 'historyEoa_change')\n\t}, [historyEoa])")
		expect(app).toContain('if (!historyEoa) return')
		// The history load effect itself: its guard and its dependency list, without the gossip flag.
		expect(app).toContain('if (!historyEoa) return\n\t\tvoid loadWorkerHistory')
	})

	it('no app call loads without a caller', () => {
		expect(app).not.toMatch(/loadWorkerHistory\(\)/)
	})

	it('the listen start loads with its caller (a foreground resume is reported by chat.ts first)', () => {
		expect(bridge).toContain('void loadWorkerHistory(undefined, consumeListenLoadCaller())')
		expect(chat).toContain('noteHistoryResumeReason(reason)')
		expect(bridge).toContain("if (reason === 'foreground_resume') listenLoadCaller = 'foreground_resume'")
	})
})
