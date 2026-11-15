/**
 * The history restore skips entries merged this session. The key is
 * owner | peer | dir | sha256(body) | ts (owner = the EOA of the signing key). seq and sendId are NOT in the key, so a rebuilt manifest
 * (new seq) or a derived send id (D10) cannot make a merged entry look new. These tests pin the collisions the key must not have, and
 * the invariance under a rebuild. SYNTHETIC entries only.
 *
 * Notes on the fields (chat SDK, dist/worker/history.js and types.d.ts):
 * - seq: the position of the record in the owner's history manifest. A local append takes the last seq + 1; a rebuild (relinearize)
 *   gives the position in the sorted order. It can change after a rebuild, so it is not part of the key.
 * - ts: the client's monotonic time in ms; it is non-decreasing, and two entries can share it.
 * - sendId: optional. With local keys the SDK derives a deterministic send key (D10) and writes it into the index; without them the
 *   record keeps an empty send id. A send id can therefore appear after a rebuild, so it is not part of the key.
 *
 * Transitional: the page type carries no sendKey today. When the SDK gives every entry a stable sendKey, the body hash can be
 * replaced by it; the tests below then need the same invariance checks against that field.
 */
import { historyEntryKey, markHistoryEntriesSeen, unseenHistoryEntries } from './historyRestoreSeen'
import type { HistoryEntry } from '@conet.project/chat-sdk'
import fs from 'fs'
import path from 'path'

const OWNER = '0x39581c72b8c7d0de85ff22cf3ae178ae813957aa'
const OWNER_B = '0x0000000000000000000000000000000000000001'
const PEER = '0x9c772e0e00000000000000000000000000009826'
const PEER_B = '0x1111111111111111111111111111111111111111'
const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
	seq: 1,
	ts: 1762000000000,
	peer: PEER,
	dir: 'in',
	sendId: 's-1',
	body: '{"text":"synthetic"}',
	...over,
})

describe('the history entry key', () => {
	it('is the same for the same entry, whatever the letter case of the owner or the peer', () => {
		expect(historyEntryKey(OWNER, entry())).toBe(historyEntryKey(OWNER.toUpperCase(), entry({ peer: PEER.toUpperCase() })))
	})

	it('has the form owner|peer|dir|sha256(body)|ts, and no seq or sendId part', () => {
		const key = historyEntryKey(OWNER, entry({ sendId: 's-1', seq: 7 }))
		expect(key).toBe(`${OWNER}|${PEER}|in|${key.split('|')[3]}|1762000000000`)
		expect(key.split('|')[3]).toMatch(/^[0-9a-f]{64}$/)
	})

	it('differs for another owner, peer, direction, body or time', () => {
		const base = historyEntryKey(OWNER, entry())
		expect(historyEntryKey(OWNER_B, entry())).not.toBe(base)
		expect(historyEntryKey(OWNER, entry({ peer: PEER_B }))).not.toBe(base)
		expect(historyEntryKey(OWNER, entry({ dir: 'out' }))).not.toBe(base)
		expect(historyEntryKey(OWNER, entry({ body: '{"text":"other"}' }))).not.toBe(base)
		expect(historyEntryKey(OWNER, entry({ ts: 1 }))).not.toBe(base)
	})

	it('relinearize invariance: a new seq, a send id that appears later, or a dropped send id keeps the key', () => {
		const base = historyEntryKey(OWNER, entry({ seq: 3, sendId: undefined }))
		// The manifest is rebuilt: the same message has another position.
		expect(historyEntryKey(OWNER, entry({ seq: 41, sendId: undefined }))).toBe(base)
		// The SDK derives a send id (D10) after the rebuild: the same message, the same key.
		expect(historyEntryKey(OWNER, entry({ seq: 41, sendId: 'derived-send-key' }))).toBe(base)
		expect(historyEntryKey(OWNER, entry({ seq: 41, sendId: 'derived-send-key' }))).toBe(historyEntryKey(OWNER, entry({ seq: 3, sendId: undefined })))
	})

	it('a rebuilt manifest does not merge the entry twice: the seen set skips it after the new seq and send id arrive', () => {
		const seen = new Set<string>()
		markHistoryEntriesSeen(OWNER, seen, [entry({ seq: 3, sendId: undefined })])
		expect(unseenHistoryEntries(OWNER, seen, [entry({ seq: 41, sendId: 'derived-send-key' })])).toEqual([])
	})
})

describe('collisions that must NOT skip a message', () => {
	it('no send id, same peer, direction and time, different bodies, in two batches: both are kept', () => {
		const seen = new Set<string>()
		const first = entry({ sendId: undefined, seq: 4, ts: 1762000000000, body: '{"text":"first"}' })
		const second = entry({ sendId: undefined, seq: 4, ts: 1762000000000, body: '{"text":"second"}' })
		markHistoryEntriesSeen(OWNER, seen, [first])
		expect(unseenHistoryEntries(OWNER, seen, [second])).toEqual([second])
	})

	it('the same body, time and peer in both directions (one sent, one received): both are kept', () => {
		const seen = new Set<string>()
		const received = entry({ dir: 'in', sendId: 'same', seq: 9, ts: 5 })
		const sent = entry({ dir: 'out', sendId: 'same', seq: 9, ts: 5 })
		markHistoryEntriesSeen(OWNER, seen, [received])
		expect(unseenHistoryEntries(OWNER, seen, [sent])).toEqual([sent])
	})

	it('the same entry under another owner (an account switch) is not skipped', () => {
		const seen = new Set<string>()
		markHistoryEntriesSeen(OWNER, seen, [entry()])
		expect(unseenHistoryEntries(OWNER_B, seen, [entry()])).toHaveLength(1)
	})
})

describe('unseenHistoryEntries and markHistoryEntriesSeen', () => {
	it('before any mark, every entry is unseen and kept in order', () => {
		const a = entry({ seq: 1, body: '{"text":"a"}' })
		const b = entry({ seq: 2, body: '{"text":"b"}' })
		expect(unseenHistoryEntries(OWNER, new Set(), [a, b])).toEqual([a, b])
	})

	it('after a mark, the same entries are not unseen any more: a repeated feed is a no-op', () => {
		const seen = new Set<string>()
		const batch = [entry({ seq: 1, body: '{"text":"a"}' }), entry({ seq: 2, body: '{"text":"b"}' }), entry({ seq: 3, body: '{"text":"c"}' })]
		markHistoryEntriesSeen(OWNER, seen, batch)
		expect(unseenHistoryEntries(OWNER, seen, batch)).toEqual([])
	})

	it('only the new entries of a feed that repeats some of them are returned', () => {
		const seen = new Set<string>()
		const a = entry({ seq: 1, body: '{"text":"a"}' })
		const b = entry({ seq: 2, body: '{"text":"b"}' })
		const c = entry({ seq: 3, body: '{"text":"c"}' })
		markHistoryEntriesSeen(OWNER, seen, [a, b])
		expect(unseenHistoryEntries(OWNER, seen, [a, b, c]).map((e) => e.seq)).toEqual([3])
	})

	it('a null entry is never returned', () => {
		expect(unseenHistoryEntries(OWNER, new Set(), [null as unknown as HistoryEntry])).toEqual([])
	})
})

describe('an empty owner skips nothing and marks nothing', () => {
	it('with no owner every entry is returned as unseen, even when the same entry was marked under a real owner', () => {
		const seen = new Set<string>()
		markHistoryEntriesSeen(OWNER, seen, [entry()])
		expect(unseenHistoryEntries('', seen, [entry()])).toHaveLength(1)
		expect(unseenHistoryEntries('', new Set(), [entry(), entry({ body: '{"text":"b"}' })])).toHaveLength(2)
	})

	it('marking with no owner records nothing, so a later owner still sees the entries as unseen', () => {
		const seen = new Set<string>()
		markHistoryEntriesSeen('', seen, [entry()])
		expect(seen.size).toBe(0)
		expect(unseenHistoryEntries(OWNER, seen, [entry()])).toHaveLength(1)
	})

	it('a null entry is still never returned', () => {
		expect(unseenHistoryEntries('', new Set(), [null as unknown as HistoryEntry])).toEqual([])
	})
})

describe('the app uses the seen set in the history restore', () => {
	const app = fs.readFileSync(path.join(__dirname, '..', 'App.tsx'), 'utf8')
	it('the batch is checked against the seen set when it is queued (the account of the page), and again when it plans (the applier)', () => {
		expect(app).toContain('const applier = createHistoryApplier({')
		expect(app).toContain('seen: restoredHistoryKeysRef.current,')
		const plan = fs.readFileSync(path.join(__dirname, 'historyRestoreApply.ts'), 'utf8')
		expect(plan).toContain('if (unseenHistoryEntries(account, deps.seen, entries).length === 0) return')
		expect(plan).toContain('const fresh = unseenHistoryEntries(owner, input.seen, input.entries)')
		expect(plan).toContain('markHistoryEntriesSeen(plan.owner, seen, plan.markable)')
	})
	it('the owner is the account of the signing key (accountEoaFor), not the keyID; the queued batch must match its key', () => {
		expect(app).toContain('accountOfKey: (pk) => accountEoaFor(pk) || \'\',')
		expect(app).not.toContain('historyOwnerEoa')
		expect(app).not.toMatch(/const owner = \(profile0\?\.keyID/)
		const plan = fs.readFileSync(path.join(__dirname, 'historyRestoreApply.ts'), 'utf8')
		expect(plan).toContain("if ((deps.accountOfKey(pk) || '').toLowerCase() !== account) {")
	})
	it('the old signature check is gone', () => {
		expect(app).not.toContain('restoredHistorySigRef')
	})
})
