/**
 * Browser inbound ACK, one test per case of the interface vectors .
 *
 * Source: interface/protocol/inbound-ack-vectors.v1.json, eighth version (sha256 c7382cdd, 37 cases). The frames below are
 * copies of the vectors' values; this test does not read the file. The vectors' records carry the field `serverAcked`. to
 * and to have no records, so the field is not used here. The seventh (), sixth () and fifth ()
 * versions are superseded.
 *
 * Not asserted, as the vector file says: the browser armor retention rule (not defined; `armorRetainedLocally` is null).
 * Not asserted here: `displayed`. The row is put in the page state before the commit, so "shown only after a successful commit"
 * is not met by the page flow (reported; the ACK and the marker follow the commit).
 *
 * The test runs the real browser pipeline: the batch lists (inboundRowRecord.ts), `settleInboundBatch` (markers, commit, ACK order) and
 * `ackInboundHashesInBrowser` as the mailbox ACK, with a fake store. The post is a fake; the frame is never sent to a server.
 */
import {
	classifyInboundLine,
	newInboundLists,
	recordDroppedLine,
	recordInboundLine,
	recordRejectedLine,
	settleInputOf,
	type InboundLists,
} from './inboundRowRecord'
import { settleInboundBatch, type InboundAckTarget } from './inboundBatchSettle'
import { ackInboundHashesInBrowser } from './browserInboundAck'

const OWN_EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'

type Frame = {
	id: string
	armorHash: string
	/**
	 * Row: a chat row for this frame. Drop: a valid control or expired frame, consumed without a row. Unparseable: decrypted text that is
	 * not JSON (marker, then ACK). Unsigned: the signature is not valid (nothing at all).
	 */
	kind: 'row' | 'drop' | 'unparseable' | 'unsigned'
	/** Commit result: true = the store write landed; false = persist fail or storage unavailable. */
	persist: boolean
}

const FRAMES: Frame[] = [
	{ id: 'row-01', armorHash: '0x4fb09dd79ad3a665af8663831fe4f3b2a396866b79dd8933acbf5a6f18d2109d', kind: 'row', persist: true },
	{ id: 'row-02', armorHash: '0x7aa66e675096bcb9d70e952efc52c467d16a8289e9c7b50b9e540cadd4609b02', kind: 'row', persist: false },
	{ id: 'row-03', armorHash: '0x81fc2201b1a26c4a621da523e3b08cf0ad4837cfd6bdd3e043f7fa7dd48d8872', kind: 'row', persist: false },
	{ id: 'row-04', armorHash: '0x2480b119ae2301766a8c76030b97363caa3a12f726e143efbcb4af9bdd589427', kind: 'drop', persist: true },
	{ id: 'row-05', armorHash: '0x9878bcbd837402334660a998af12352fb40881a14ee05315de45438e78f441f8', kind: 'drop', persist: false },
	{ id: 'case-01', armorHash: '0xf39d92c615f7229e3ba234c9a967aba31f66e19c67187d7388c5ecbb2903c838', kind: 'unparseable', persist: true },
	{ id: 'case-02', armorHash: '0xc70e482d56a44333dfbb479812be59826a78425b1f04da450c034cc4b09492e2', kind: 'unsigned', persist: true },
]

/** Runs one vector: the frame goes through settle with the browser target and the real browser ACK. */
async function runVector(frame: Frame) {
	const line = `line:${frame.id}`
	const memory = new Set<string>()
	const persisted = new Set<string>()
	let commits = 0
	const posted: Array<Record<string, unknown>> = []
	const sent = new Set<string>()
	const ackPromises: Array<Promise<number>> = []

	const target: InboundAckTarget = {
		browser: true,
		ackMailbox: (hashes) => {
			ackPromises.push(
				ackInboundHashesInBrowser(hashes, {
					eoa: OWN_EOA,
					post: async (command) => {
						posted.push(command)
						return true
					},
					isSent: (hash) => sent.has(hash),
					noteSent: (hash) => {
						sent.add(hash)
					},
					attempts: 1,
					retryDelayMs: 0,
				}),
			)
		},
		ackDisplayed: () => {
			throw new Error('the browser path never calls ackInbound')
		},
		alreadyAcked: () => false,
	}

	const lists: InboundLists = newInboundLists()
	if (frame.kind === 'row') recordInboundLine(lists, line, true, { write: () => undefined })
	else if (frame.kind === 'drop' || frame.kind === 'unparseable') recordDroppedLine(lists, line)
	else if (frame.kind === 'unsigned') recordRejectedLine(lists, line)
	const stored = await settleInboundBatch(settleInputOf(lists), {
		target,
		hashesOf: (ls) => ls.map(() => frame.armorHash),
		markHashes: (hashes) => {
			const added = hashes.filter((h) => !memory.has(h))
			added.forEach((h) => memory.add(h))
			return added
		},
		unmarkHashes: (hashes) => hashes.forEach((h) => memory.delete(h)),
		commit: async () => {
			commits += 1
			if (!frame.persist) return false
			memory.forEach((h) => persisted.add(h))
			return true
		},
		release: () => undefined,
	})
	await Promise.all(ackPromises)
	return { stored, commits, persisted, posted, rowLines: lists.stored, dropLines: lists.dropped, rejectedLines: lists.rejected }
}

const frame = (id: string): Frame => {
	const f = FRAMES.find((x) => x.id === id)
	if (!f) throw new Error(`no frame ${id}`)
	return f
}

describe('browser inbound ACK vectors to ', () => {
	it('commit succeeds, one row written, one ACK after the commit, dedupe record written with the commit', async () => {
		const f = frame('row-01')
		const r = await runVector(f)
		expect(r.stored).toBe(true)
		expect(r.commits).toBe(1)
		expect(r.rowLines).toHaveLength(1)
		expect(r.posted.map((c) => c.armorHash)).toEqual([f.armorHash])
		expect(r.posted[0]).toMatchObject({ command: 'gossip_delivery_ack', walletAddress: OWN_EOA })
		expect(r.persisted.has(f.armorHash)).toBe(true)
	})

	it('commit fails, no ACK, no dedupe record, the frame stays on the server', async () => {
		const f = frame('row-02')
		const r = await runVector(f)
		expect(r.stored).toBe(false)
		expect(r.commits).toBe(1)
		expect(r.posted).toEqual([])
		expect(r.persisted.has(f.armorHash)).toBe(false)
	})

	it('storage unavailable (commit resolves false), no ACK, no dedupe record', async () => {
		const f = frame('row-03')
		const r = await runVector(f)
		expect(r.stored).toBe(false)
		expect(r.posted).toEqual([])
		expect(r.persisted.has(f.armorHash)).toBe(false)
	})

	it('an expired signal is dropped; the marker commit succeeds; only the armor hash is recorded, then one ACK', async () => {
		const f = frame('row-04')
		const r = await runVector(f)
		expect(r.stored).toBe(true)
		expect(r.rowLines).toEqual([])
		expect(r.dropLines).toHaveLength(1)
		expect(r.persisted.has(f.armorHash)).toBe(true)
		expect(r.posted.map((c) => c.armorHash)).toEqual([f.armorHash])
	})

	it('a dropped voice-control line whose marker commit fails: no marker kept, no ACK, the frame stays on the server', async () => {
		const f = frame('row-05')
		const r = await runVector(f)
		expect(r.stored).toBe(false)
		expect(r.persisted.has(f.armorHash)).toBe(false)
		expect(r.posted).toEqual([])
	})

	it('decrypted text that is not JSON: the marker is written before the commit, the ACK follows it; no display, no armor', async () => {
		const f = frame('case-01')
		const r = await runVector(f)
		expect(r.stored).toBe(true)
		expect(r.rowLines).toEqual([])
		expect(r.persisted.has(f.armorHash)).toBe(true)
		expect(r.posted.map((c) => c.armorHash)).toEqual([f.armorHash])
	})

	it('the signature is not valid: not delivered, not stored, no marker, no ACK; the frame stays on the server', async () => {
		const f = frame('case-02')
		const r = await runVector(f)
		expect(r.rejectedLines).toHaveLength(1)
		expect(r.rowLines).toEqual([])
		expect(r.dropLines).toEqual([])
		expect(r.persisted.has(f.armorHash)).toBe(false)
		expect(r.posted).toEqual([])
	})

	// and: a JSON object that lacks signMessage or text is a failed signature check. The raw lines are
	// built here and classified by the same classifier the App uses.
	const rawIc03 = JSON.stringify({ text: 'hello', from: '0x9858effd232b4033e47d90003d41ec34ecaeda94' })
	const rawIc04 = JSON.stringify({ signMessage: '0x12', from: '0x9858effd232b4033e47d90003d41ec34ecaeda94' })
	const classifyAndSettle = async (raw: string, hash: string, persist: boolean) => {
		const lists = newInboundLists()
		const c = classifyInboundLine(raw)
		if (c.kind === 'unparseable') recordDroppedLine(lists, raw)
		else if (c.kind === 'rejected') recordRejectedLine(lists, raw)
		const memory = new Set<string>()
		const persisted = new Set<string>()
		const posted: string[] = []
		await settleInboundBatch(settleInputOf(lists), {
			target: {
				browser: true,
				alreadyAcked: () => false,
				ackMailbox: (hashes) => hashes.forEach((h) => posted.push(h)),
				ackDisplayed: () => {
					throw new Error('the browser path never calls ackInbound')
				},
			},
			hashesOf: (ls) => ls.map(() => hash),
			markHashes: (hashes) => {
				const added = hashes.filter((h) => !memory.has(h))
				added.forEach((h) => memory.add(h))
				return added
			},
			unmarkHashes: (hashes) => hashes.forEach((h) => memory.delete(h)),
			commit: async () => {
				if (!persist) return false
				memory.forEach((h) => persisted.add(h))
				return true
			},
			release: () => undefined,
		})
		return { kind: c.kind, lists, memory, persisted, posted }
	}

	it('a JSON object without signMessage is a failed signature check: not delivered, no marker, no ACK, the frame stays', async () => {
		const hash = '0xb286cbce729aa2333ea539c5f43372149c2421ac8623ff9f8a075e37207e378e'
		const r = await classifyAndSettle(rawIc03, hash, true)
		expect(r.kind).toBe('rejected')
		expect(r.lists.rejected).toHaveLength(1)
		expect(r.lists.dropped).toEqual([])
		expect(r.memory.size).toBe(0)
		expect(r.persisted.size).toBe(0)
		expect(r.posted).toEqual([])
	})

	it('a JSON object without text is a failed signature check: not delivered, no marker, no ACK, the frame stays', async () => {
		const hash = '0x43e7c1aa459eecda5c60de03eda051f93fef82400aab51fee6a6246a5bd19428'
		const r = await classifyAndSettle(rawIc04, hash, true)
		expect(r.kind).toBe('rejected')
		expect(r.lists.rejected).toHaveLength(1)
		expect(r.lists.dropped).toEqual([])
		expect(r.memory.size).toBe(0)
		expect(r.persisted.size).toBe(0)
		expect(r.posted).toEqual([])
	})

	// and: decrypted JSON that is an array or a string has no signature to check: a failed signature check.
	it('a JSON array has no signature to check: not delivered, no marker, no ACK, the frame stays', async () => {
		const hash = '0xb2cfd811fa737c3bc4fa561672c9430f3e6283d699ee2c3d29588eaefe3861b5'
		const r = await classifyAndSettle(JSON.stringify(['a', 'b']), hash, true)
		expect(r.kind).toBe('rejected')
		expect(r.lists.rejected).toHaveLength(1)
		expect(r.lists.dropped).toEqual([])
		expect(r.memory.size).toBe(0)
		expect(r.persisted.size).toBe(0)
		expect(r.posted).toEqual([])
	})

	it('a JSON string has no signature to check: not delivered, no marker, no ACK, the frame stays', async () => {
		const hash = '0x8d3d164041204890f0652210918f449b783588094c9c4e8669bf48defd91e301'
		const r = await classifyAndSettle(JSON.stringify('hello'), hash, true)
		expect(r.kind).toBe('rejected')
		expect(r.lists.rejected).toHaveLength(1)
		expect(r.lists.dropped).toEqual([])
		expect(r.memory.size).toBe(0)
		expect(r.persisted.size).toBe(0)
		expect(r.posted).toEqual([])
	})
})

