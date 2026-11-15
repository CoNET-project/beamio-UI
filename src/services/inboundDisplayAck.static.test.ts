/**
 * the acknowledgement semantics of the chat channel.
 * - The native module sends the server ACK (`gossip_delivery_ack`) at store time; the page sends nothing for it.
 * - The page calls `ackInbound`after the commit, only for lines that have a row in the store. Dropped lines get no native ACK.
 * - The page declares the capability (`deferAck: true` in init).
 * - The behaviour (order, gating, rollback) is tested in inboundBatchSettle.test.ts and browserInboundAck.vectors.test.ts. This file
 *   reads the sources only to pin the wiring that those tests cannot reach. SYNTHETIC values only.
 */
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')
const protocol = fs.readFileSync(path.join(ROOT, 'vendor', 'conet-chat-sdk', 'src', 'protocol.ts'), 'utf8')
const bridge = fs.readFileSync(path.join(__dirname, 'chatWorkerBridge.ts'), 'utf8')
const transport = fs.readFileSync(path.join(__dirname, 'nativeConetChatTransport.ts'), 'utf8')
const app = fs.readFileSync(path.join(ROOT, 'src', 'App.tsx'), 'utf8')

/** The text of one exported function or arrow function, from its first line to its closing brace. */
function block(src: string, start: string): string {
	const at = src.indexOf(start)
	if (at < 0) return ''
	const open = src.indexOf('{', at)
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

describe('ackInbound and the server ACK', () => {
	it('vendor protocol: the old deferAck wording is gone and the new semantics are stated', () => {
		expect(protocol).not.toContain('hold the mailbox ACK and the sender receipt')
		expect(protocol).not.toContain('send the mailbox ACK and the sender receipt now')
		expect(protocol).not.toContain('the mailbox ACK waits until the page stored the message')
		expect(protocol).toContain('The page calls `ackInbound` after it has shown the message')
		expect(protocol).toContain('The page has shown these inbound messages')
		expect(protocol).toContain('Never a server ACK')
	})

	it('vendor protocol: the ackInbound table no longer lists an own-mailbox ACK', () => {
		const table = protocol.slice(protocol.indexOf('\tackInbound: {'), protocol.indexOf('\tpause: {'))
		expect(table).toContain("walletSignature: ['recipientLayer']")
		expect(table).not.toContain('Own mailbox B: `gossip_delivery_ack`')
	})

	it('chatWorkerBridge: the ACK target is captured at store time; native ackInbound needs the capability and a stored row', () => {
		const capture = block(bridge, 'export const captureInboundAckTarget')
		expect(capture).toContain("daemonAllows('inbound.deferAck')")
		expect(capture).toContain('const native = client && isNativeConetChatClient(client) && daemonAllows')
		// The client is captured once, not read again when the commit resolves.
		expect(capture.slice(capture.indexOf('ackDisplayed: (armorHashes)'))).not.toContain('activeClient')
		expect(capture.slice(capture.indexOf('ackMailbox: (armorHashes)'), capture.indexOf('ackDisplayed: () => undefined'))).not.toContain('activeClient')
		expect(bridge).not.toContain('confirmInboundStored')
		expect(bridge).not.toContain('ackInboundDisplayed')
	})

	it('chatWorkerBridge: the display step is the only place that calls the native ackInbound', () => {
		expect(bridge.split('native.ackInbound(').length - 1).toBe(1)
		expect(bridge.split('.ackInbound(').length - 1).toBe(1)
	})

	it('App.tsx: the store step settles rows and dropped lines separately; native ackInbound waits for the next frame after the commit', () => {
		expect(app).toContain('settleInboundBatch(settleInputOf(inboundLists), {')
		expect(app).toContain('requestAnimationFrame(() => ackTarget.ackDisplayed(hashes))')
		expect(app).toContain('captureInboundAckTarget()')
		expect(app).not.toContain('confirmInboundStored')
		expect(app).not.toContain('ackInboundDisplayed')
	})

	it('App.tsx: the replay path splits lines with a row in this session from the rest; only the rows are ACKed natively', () => {
		expect(app).toContain('(key && storedRowKeysRef.current.has(key) ? replayRows : replayDrops).push(raw)')
		// a replayed line is verified again (fields and signature) before it can be ACKed, whatever its key.
		expect(app).toContain('const replayed = classifyInboundLine(raw)')
		expect(app).toContain("if (replayed.kind === 'rejected') continue")
		expect(app).toContain("if (replayed.kind === 'signed' && !inboundSignatureValid(replayed.message as unknown as message)) continue")
		expect(app).toContain('settleInboundBatch({ rowLines: replayRows, dropLines: replayDrops }, {')
		expect(app).toContain('storedRowKeysRef.current.add(rowKey)')
		// -1: a row is recorded through the helper, after its write (the helper runs the mirror, then the write, then records).
		expect(app).toContain('recordInboundLine(inboundLists, raw, isNew, {')
		expect(app).not.toContain('storedLines')
	})

	it('App.tsx: a line that does not parse is a dropped line, not an unknown one', () => {
		expect(app).toContain('const line = classifyInboundLine(raw)')
		expect(app).toContain("if (line.kind === 'unparseable') { recordDroppedLine(inboundLists, raw); continue }")
		expect(app).toContain("if (line.kind === 'rejected') {")
		expect(app).not.toContain('const msg: message = JSON.parse(raw)')
	})

	it('App.tsx: a line that throws while it is stored is forgotten, so the mailbox redelivery is processed again', () => {
		expect(app).toContain('if (failedKey) processedIdsRef.current.delete(failedKey)')
	})

	it('App.tsx: discard points record their line; the browser receipt path sends no mailbox ACK before the commit', () => {
		expect(app.split('recordDroppedLine(inboundLists, raw)').length - 1).toBeGreaterThanOrEqual(3)
		// a signature that is not valid is rejected, not dropped; it is never passed to the settle step.
		expect(app).toContain('recordRejectedLine(inboundLists, raw)')
		expect(app).not.toContain('discardedLines')
		expect(app).toContain('if (isInboundLineMarked(raw) || !key || processedIdsRef.current.has(key)) {')
		expect(app).toContain('if (!inboundAckIsBrowser() && armorHashRaw && ackCtx?.routerArmoredPublicKey && pk) {')
		expect(app).toContain('skipMailboxAck: inboundAckIsBrowser(),')
		const settle = app.indexOf('settleInboundBatch(settleInputOf(inboundLists)')
		expect(settle).toBeGreaterThan(app.indexOf('setCoNET_Data(temp)'))
		expect(app.indexOf('markHashes: recordInboundDedupeMarkers', settle)).toBeGreaterThan(settle)
		expect(app.indexOf('commit: storeSystemDataAndWait', settle)).toBeGreaterThan(app.indexOf('markHashes: recordInboundDedupeMarkers', settle))
	})

	it('nativeConetChatTransport: the page declares support (deferAck: true) in init and ackInbound is documented as the display step', () => {
		expect(transport).toContain('deferAck: true,')
		expect(transport).not.toContain("deferAck: this.allows('inbound.deferAck')")
		expect(transport).toContain('The page calls this after it has stored or shown the inbound messages')
	})
})
