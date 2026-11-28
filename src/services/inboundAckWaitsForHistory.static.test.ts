/**
 * @jest-environment node
 *
 * how the page wires the ACK to the history append. The behaviour itself is tested in inboundDurable.test.ts (the real settle step and wait); this pins the wiring that a render of App.tsx cannot reach here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const srcRoot = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(srcRoot, p), 'utf8')
const code = (text: string): string => text.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')

describe('inbound mailbox ACK: the wiring', () => {
	const app = code(read('App.tsx'))
	const mirror = app.slice(app.indexOf('mirror: (rowIsNew) => {'), app.indexOf('// ✅ 放回 chats（不可变）'))

	it('every message line\'s mirror comes from inboundMirrorFor (tested on its own: inboundMirror.test.ts), with the browser flag, the new-row flag and nothing about the mode; no hold switch', () => {
		expect(mirror).toContain('mirror: (rowIsNew) => {')
		expect(mirror).toContain("return inboundMirrorFor({ alsoRequire: receiptRecorded, browser: inboundAckIsBrowser(), nativeAckAfterAppend: nativeAckAfterAppendActive(), isNew: rowIsNew, peer: nextChat.address, msgKey: getMsgKey(raw) || undefined, added: addedInbound, ack: mirrorChatMessageToHistoryAck, failureOf: appendFailureOf, fireAndForget: mirrorChatMessageToHistory,")
		expect(mirror).not.toContain('libraryHoldsForMode(libraryPersistModeFor(mirrorEoa))')
		expect((mirror.match(/mirrorChatMessageToHistoryAck/g) ?? []).length).toBe(1)
		expect(app).not.toMatch(/holdForAppend/)
	})

	it('the batch settle of new rows passes the durable options: a counting log line and a stop when the account changes', () => {
		const site = app.slice(app.indexOf('void settleInboundBatch(settleInputOf(inboundLists)'))
		expect(site).toMatch(/durableOptions: \{ onAbandoned: [^\n]*?log: \(message\) => publishNativePwaLog\('warn', `\[inboundAck\] \$\{message\}`\), alive:/)
		expect(site).toContain('profileEoaOf(')
	})

	it('a browser mailbox ACK leaves the page from exactly two call sites: the wait after a confirmed append, and the dropped-line ACK of the settle step', () => {
		const durable = code(read('services/inboundDurable.ts'))
		expect((durable.match(/deps\.ackMailbox\(/g) ?? []).length).toBe(1)
		expect(durable.indexOf('if (ok) {')).toBeLessThan(durable.indexOf('deps.ackMailbox('))
		expect(durable.indexOf('deps.ackMailbox(')).toBeLessThan(durable.indexOf('failedHere += 1'))
		const settle = code(read('services/inboundBatchSettle.ts'))
		expect((settle.match(/deps\.target\.ackMailbox\(/g) ?? []).length).toBe(1)
		// the immediate ACK is the DROPPED lines only (never a row, never a duplicate), minus every hash whose wait is already running
		expect(settle).toContain('const ackNow = dropHashes.filter((h) => !isDurablePending(h))')
		expect(settle).toContain('const dropHashes = browser ? dropHashesAll.filter((h) => !rowOrDup.has(h)) : dropHashesAll')
		expect(settle).not.toMatch(/ackNow = (allHashes|rowHashes|dupHashes)/)
		// every caller of the one browser exit (chatWorkerBridge ackMailbox -> ackInboundHashesInBrowser) is audited here
		const users = ['App.tsx', 'services/chat.ts', 'pages/chat/chat.tsx', 'services/chatWorkerBridge.ts', 'services/inboundDurable.ts', 'services/inboundBatchSettle.ts'].filter((f) => /ackInboundHashesInBrowser/.test(code(read(f))))
		expect(users).toEqual(['services/chatWorkerBridge.ts'])
	})

	it('every hashesOf lookup in the settle step comes BEFORE the release (releaseInboundLines deletes the pending lines that hashesOf reads)', () => {
		const settle = code(read('services/inboundBatchSettle.ts'))
		const release = settle.indexOf('deps.release(')
		expect(release).toBeGreaterThan(0)
		expect(settle.slice(release)).not.toMatch(/hashesOf\(/) // nothing after the release asks for a hash
		expect(settle).toContain('const hashesOfLine = new Map<string, string[]>()')
		expect(settle.indexOf('const hashesOfLine = new Map')).toBeLessThan(release)
	})

	it('App routes a frame that does not parse INTO the batch (first arrival and redelivery) as a dropped line and logs counts and hash tails; an abandoned wait makes the page forget the line', () => {
		const loop = app.slice(app.indexOf('const replayDrops: string[] = []'), app.indexOf('const confirmAlreadyHandled = () => {'))
		// the route is decided by the pure function, with nothing deciding before it (no marker / key check of its own in the loop)
		expect(loop).toContain('const route = routeArrivedLine(raw, { key, marked: isInboundLineMarked(raw), seen: !!key && processedIdsRef.current.has(key) })')
		expect(loop).not.toContain('if (isInboundLineMarked(raw)')
		expect(loop).toMatch(/if \(route === 'drop_unparseable'\) \{\s*toProcess\.push\(raw\)\s*continue/)
		expect(loop.indexOf("route === 'drop_unparseable'")).toBeLessThan(loop.indexOf("route === 'already_handled'"))
		expect(loop).toContain("if (replayed.kind !== 'signed') continue")
		expect(app).not.toContain('replayRejects')
		// the batch: a whitespace-only frame is not filtered out before it can be dropped
		expect(app).toContain('if (!raw || seenRaw.has(key)) continue')
		// the log is written before the settle step releases the lines
		const logAt = app.indexOf('unparseableDropLogLine(unparseableLines.length, inboundArmorHashesOf(unparseableLines))')
		expect(logAt).toBeGreaterThan(0)
		expect(logAt).toBeLessThan(app.indexOf('void settleInboundBatch(settleInputOf(inboundLists)'))
		expect(app).toContain('onAbandoned: (m) => { if (m.msgKey) { processedIdsRef.current.delete(m.msgKey); storedRowKeysRef.current.delete(m.msgKey) } }')
		expect(app).toContain('msgKey: getMsgKey(raw) || undefined')
		const durable = code(read('services/inboundDurable.ts'))
		expect((durable.match(/opts\.onAbandoned\?\.\(item\.mirror\)/g) ?? []).length).toBe(2) // both abandon sites
	})

	it('the SDK append request waits at least as long as the page\'s own wait (120 s), so a serial queue of appends is not cut at 20 s (a longer timeout is not evidence of a fix: it only avoids repeated "not saved")', () => {
		const client = readFileSync(join(srcRoot, '..', 'vendor/conet-chat-sdk/src/client.ts'), 'utf8')
		const m = client.match(/type: 'historyAppend', reqId: 0, entry, \.\.\.\(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && opts\?\.qaRemoteFault \? \{ qaRemoteFault: opts\.qaRemoteFault \} : \{\}\) \}, ([0-9_]+)\)/)
		expect(m).not.toBeNull()
		expect(Number((m as RegExpMatchArray)[1].replace(/_/g, ''))).toBeGreaterThanOrEqual(120_000)
	})

	it('the native path is not touched: ackDisplayed is still sent only for rows, after the commit', () => {
		const settle = code(read('services/inboundBatchSettle.ts'))
		expect(settle).toContain('const nativeHashes = unique([...rowHashes, ...dupHashes.filter((h) => !deps.target.alreadyAcked(h))])')
		expect(settle.indexOf('if (deps.target.browser) {')).toBeLessThan(settle.indexOf('const nativeHashes'))
	})
})
