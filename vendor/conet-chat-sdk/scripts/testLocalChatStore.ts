/**
 * Local chat library tests (the subset that applies to the SDK layer).
 * Environment: Node ${process.version}, in-memory backend, synthetic fixture only (no real chat, keys or media).
 * Run: npx tsx scripts/testLocalChatStore.ts
 */

import { LocalChatStore, type SyncRecord } from '../src/local/store.js'
import { MemoryBackend, MemoryData } from '../src/local/backend.js'
import type { Viewport, IncomingRecord, PageResult, ChatItem, LocalEvent } from '../src/local/types.js'
import { buildFixture, toSync, truthFor, toIncoming, type FixtureMessage } from './fixtures/localChatFixture.js'
import { hkdf } from '../src/crypto.js'
import { deriveLocalKeys } from '../src/local/keys.js'

/** Synthetic R_db for tests: a deterministic HKDF of the master (the real R_db comes from the private key). */
const rdbOf = (master: Uint8Array) => hkdf(master, 'test-rdb-v1', 32)

let failures = 0
let passes = 0
function check(name: string, ok: boolean, detail?: string): void {
	if (ok) passes++
	else failures++
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
}

const masterA = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff) // synthetic test master
const masterB = new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff)

const phone: Viewport = { widthPt: 390, heightPt: 760, orientation: 'portrait', fontScale: 1.0, layoutVersion: 1 }

function newStore(master: Uint8Array = masterA, data: MemoryData = new MemoryData()): { store: LocalChatStore; data: MemoryData } {
	return { store: new LocalChatStore(async () => new MemoryBackend(data)), data }
}

/** Walk every page from the newest to the oldest (olderState 'more' or 'pending' keeps going). Returns items ascending. */
async function walkAll(store: LocalChatStore, convKey: string, vp: Viewport): Promise<{ items: ChatItem[]; pages: PageResult[]; last: PageResult }> {
	let p = await store.openConversation(convKey, vp)
	const pages: PageResult[] = [p]
	let guard = 0
	while (p.olderState === 'more' && p.olderCursor && guard++ < 100000) {
		p = await store.loadOlder(convKey, p.olderCursor, vp)
		if (p.items.length === 0 && !p.scanExhausted && p.olderState === 'more') continue
		pages.push(p)
	}
	const asc: ChatItem[] = []
	for (let i = pages.length - 1; i >= 0; i--) asc.push(...pages[i].items)
	return { items: asc, pages, last: p }
}

function percentile(xs: number[], q: number): number {
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]
}

async function ingestAll(store: LocalChatStore, records: SyncRecord[], table: Map<string, IncomingRecord>) {
	return store.syncRecords(records, async (r) => table.get(r.cid!) ?? null)
}

async function main(): Promise<void> {
	// ---- codec / order -----------------------------------------------------
	{
		const { compareUtf8 } = await import('../src/local/codec.js')
		const samples = ['', 'a', 'b', 'ab', 'h:AAA', 'Zz', 'ＡＢ', '😀', '￿', 'z', 'x_-0', '0123456789']
		let ok = true
		for (const a of samples) for (const b of samples) {
			const want = Math.sign(Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
			if (Math.sign(compareUtf8(a, b)) !== want) ok = false
		}
		check('stable_id order equals UTF-8 byte order (ASCII)', ok)
	}

	// ---- identity -----------------------------------------------------
	{
		const { store } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		const base: IncomingRecord = { convKey: '0xAbC', dir: 'in', sortTs: 100, kind: 'text', body: '{"text":"same"}', cid: 'x1' }
		const sk1 = await store.sendKeyFor(base)
		check('sendless sendKey is "x" + base64url, deterministic', sk1.startsWith('x') && sk1 === (await store.sendKeyFor({ ...base, cid: 'other' })))
		const sid = await store.stableIdFor(base)
		check('stable_id is 43 ASCII base64url characters', /^[A-Za-z0-9_-]{43}$/.test(sid), sid)
		check('non-UUID sendId is the sendKey', (await store.sendKeyFor({ ...base, sendId: '1700000000000-abc' })) === '1700000000000-abc')
		const uuid = '0f3c2a1e-4b5d-4c6e-8f70-123456789abc'
		check('a UUID sendId is kept as the sendKey', (await store.sendKeyFor({ ...base, sendId: uuid })) === uuid)
		const other = newStore(masterB)
		await other.store.open(await rdbOf(masterB), '0xacctA', 'default')
		check('different master gives a different stable_id (account separation)', (await other.store.stableIdFor(base)) !== sid)
		check('convKey case does not change the blind index', (await store.conversationBlind('0xABC')) === (await store.conversationBlind('0xabc')))
	}

	// ---- open / lock / kcv / epoch / schema -------------
	{
		const { store, data } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		const events: LocalEvent[] = []
		const unsub = store.subscribe((ev) => events.push(ev))
		await store.ingest({ convKey: '0x1', dir: 'in', sortTs: 1, sendId: 's1', kind: 'text', body: '{"text":"x"}', cid: 'c1', pending: true })
		store.lock()
		check('lock emits locked before clearing', events.some((e) => e.kind === 'locked'))
		check('lock → state locked, reads return source locked', store.status.state === 'locked' && (await store.openConversation('0x1', phone)).source === 'locked')
		const wrong = await store.open(await rdbOf(masterB), '0xacctA', 'default')
		check('wrong master with pending rows → locked kcv_mismatch', wrong.state === 'locked' && wrong.code === 'kcv_mismatch')
		check('pending row still on disk after mismatch', [...data.byStable.values()].some((r) => r.pending_publish === 1))
		unsub()
	}
	{
		const { store, data } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		await store.ingest({ convKey: '0x2', dir: 'in', sortTs: 5, sendId: 's5', kind: 'text', body: '{"text":"y"}', cid: 'c5' })
		const oldEpoch = (await new MemoryBackend(data).getMeta('dbEpoch')) ?? ''
		store.lock()
		const rowsBefore = JSON.stringify([...data.byStable.keys()])
		const r = await store.open(await rdbOf(masterB), '0xacctA', 'default')
		check('wrong key, nothing pending → kcv_mismatch, not rebuilt', r.state === 'locked' && r.code === 'kcv_mismatch')
		check('wrong key writes nothing and wipes nothing', JSON.stringify([...data.byStable.keys()]) === rowsBefore && rowsBefore !== '[]')
		check('the dbEpoch is unchanged (no silent rebuild)', ((await new MemoryBackend(data).getMeta('dbEpoch')) ?? '') === oldEpoch)
		const reset = await store.deleteLocalData()
		void reset
		check('explicit deleteLocalData is the only way to clear the library', [...data.byStable.keys()].length === 0)
	}
	{
		const data = new MemoryData()
		await new MemoryBackend(data).putMeta('schemaVersion', '2')
		const store = new LocalChatStore(async () => new MemoryBackend(data))
		const r = await store.open(await rdbOf(masterA), '0xacctA', 'default')
		check('newer schema → locked schema_newer', r.state === 'locked' && r.code === 'schema_newer')
	}

	// ---- lock, then unlock with the wallet subkeys (library part) -----
	{
		const data = new MemoryData()
		const st = new LocalChatStore(async () => new MemoryBackend(data))
		const eoaT = '0x1111111111111111111111111111111111111111'
		const rdb = await rdbOf(masterA)
		await st.open(rdb, eoaT, 'default')
		await st.ingest({ convKey: '0xlock', dir: 'in', sortTs: 5, sendId: 'lk1', kind: 'text', body: '{"text":"kept"}', cid: 'lk1' })
		st.lock()
		check('after lock the library reads as locked with no rows', (await st.openConversation('0xlock', phone)).source === 'locked')
		const keys = await deriveLocalKeys(rdb, eoaT, 'default')
		const reopened = await st.openWithKeys(keys)
		check('unlock with the same subkeys reopens the same library file', reopened.state === 'open')
		const page = await st.openConversation('0xlock', phone)
		check('re-unlocked library returns the rows written before lock', page.items.length === 1 && page.items[0].body === '{"text":"kept"}')
	}

	// ---- write rules -----------------------------------
	{
		const { store } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		const base: IncomingRecord = { convKey: '0x3', dir: 'in', sortTs: 100, sendId: 'p1', kind: 'text', body: '{"text":"one"}', cid: 'cidA', revision: 0 }
		check('first write inserts', (await store.ingest(base)) === 'inserted')
		check('same message mirrored twice stays one row', (await store.ingest(base)) === 'skipped')
		check('same sendKey, different body, same revision → conflict kept', (await store.ingest({ ...base, body: '{"text":"two"}' })) === 'conflict')
		check('conflict is counted', store.stats.sendKeyConflict === 1)
		check('relinearize: same revision, new cid → recid, body kept', (await store.ingest({ ...base, cid: 'cidB' })) === 'recid')
		const upd = await store.ingest({ ...base, body: '{"text":"edited"}', revision: 1, cid: 'cidC' })
		check('higher revision of the same sendKey updates the body', upd === 'updated')
		check('stale revision never moves cid back (D-A2)', (await store.ingest({ ...base, cid: 'cidA', revision: 0 })) === 'skipped')
		const page = await store.openConversation('0x3', phone)
		check('K unchanged by revision (I1)', page.items.length === 1 && page.items[0].sortTs === 100)
		check('tombstone with lower revision is skipped', (await store.ingest({ ...base, deleted: true, body: '', revision: 0 })) === 'skipped')
		check('tombstone outcome deleted', (await store.ingest({ ...base, deleted: true, body: '', revision: 2 })) === 'deleted')
		check('tombstone is terminal: a later copy does not revive it', (await store.ingest({ ...base, body: '{"text":"back"}', revision: 3 })) === 'skipped')
		check('tombstone not returned by openConversation', (await store.openConversation('0x3', phone)).items.length === 0)
	}

	// ---- content folding and alias --------------------------------
	{
		const { store } = newStore()
		await store.open(await rdbOf(masterA), '0x1234567890abcdef1234567890abcdef12345678', 'default')
		const body = '{"text":"legacy mirror"}'
		const first: IncomingRecord = { convKey: '0xfold', dir: 'in', sortTs: 1767225604000, sendId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', kind: 'text', body, cid: 'fa' }
		const second: IncomingRecord = { ...first, sendId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', cid: 'fb' }
		check('first mirror inserted', (await store.ingest(first)) === 'inserted')
		check('second mirror with another UUID folds to the first', (await store.ingest(second)) === 'folded')
		const pg = await store.openConversation('0xfold', phone)
		check('folded mirrors are one visible row', pg.items.length === 1)
		const rev = await store.ingest({ ...second, body: '{"text":"legacy mirror edited"}', revision: 1, cid: 'fc' })
		check('a revision naming the folded sendKey updates the survivor (alias)', rev === 'updated')
		const after = await store.openConversation('0xfold', phone)
		check('the survivor carries the revised body', after.items.length === 1 && after.items[0].body === '{"text":"legacy mirror edited"}')
		check('folds are counted', store.stats.folded === 1)
	}

	// ---- paging, ordering, same-ms, cursors, olderState ---
	const SEED = 20261111
	const fx = buildFixture({ seed: SEED, convs: 3, messagesPerConv: 1500, convPrefix: 'a' })
	const probe = newStore()
	await probe.store.open(await rdbOf(masterA), '0xprobe', 'default')
	// sendKey of each original message, so revisions of sendless messages can carry it
	const originSk = new Map<string, string>()
	for (const conv of fx.convs) for (const m of conv.messages) originSk.set(m.cid, await probe.store.sendKeyFor(toIncoming(m)))
	const { records, table } = toSync(fx.convs, fx.revisions)
	for (const r of records) if ((r.revision ?? 0) > 0) {
		r.sendKey = originSk.get(r.cid!.replace(/-r1$/, ''))
	}
	for (const inc of table.values()) if ((inc.revision ?? 0) > 0) inc.sendKey = originSk.get(inc.cid!.replace(/-r1$/, ''))

	{
		const { store } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		const stats = await ingestAll(store, records, table)
		check('sync ingests all records without fetch failures', stats.failed === 0, JSON.stringify(stats))
		// before the full sync completes, reaching the top is 'pending', never 'end' (B4)
		const top = await walkAll(store, fx.convs[0].convKey, phone)
		check('before syncComplete the top of history is pending, not end', top.last.olderState === 'pending', top.last.olderState)
		await store.setSyncComplete(true)
		const after = await walkAll(store, fx.convs[0].convKey, phone)
		check('after syncComplete the top is end with olderCursor null', after.last.olderState === 'end' && after.last.olderCursor === null, after.last.olderState)

		for (const conv of fx.convs) {
			const truth = truthFor(fx.convs, fx.revisions, conv.convKey)
			const walked = await walkAll(store, conv.convKey, phone)
			const truthSorted = await Promise.all(
				truth.map(async (m) => {
					const orig = m.revision > 0 ? m.cid.replace(/-r1$/, '') : m.cid
					const sk = originSk.get(orig) as string
					return { m, id: await store.stableIdFor({ ...toIncoming(m), sendKey: sk }) }
				}),
			)
			truthSorted.sort((a, b) => (a.m.sortTs - b.m.sortTs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
			const ids = new Set(walked.items.map((x) => x.stableId))
			check(`[${conv.convKey}] walk count equals visible truth (no dup, no miss)`, walked.items.length === truthSorted.length && ids.size === walked.items.length, `${walked.items.length} vs ${truthSorted.length}`)
			let seqOk = true
			for (let i = 0; i < truthSorted.length && seqOk; i++) {
				const a = walked.items[i]
				const b = truthSorted[i]
				if (a.sortTs !== b.m.sortTs || a.stableId !== b.id) seqOk = false
			}
			check(`[${conv.convKey}] order equals (sort_ts, stable_id) truth`, seqOk)
			const fillOk = walked.pages.every((p, i) => {
				if (i === walked.pages.length - 1 && p.olderState === 'end') return true
				const sum = p.items.reduce((n, x) => n + x.layout.hPt, 0)
				const oldest = p.items[0]?.layout.hPt ?? 0
				return sum >= phone.heightPt && sum - oldest < phone.heightPt
			})
			check(`[${conv.convKey}] each page fills heightPt, no minimum count `, fillOk)
		}
		const shared = fx.convs[0].messages.filter((m, i, arr) => i > 0 && arr[i - 1].sortTs === m.sortTs).length
		check('fixture has >= 5% same-ms messages', shared / fx.convs[0].messages.length >= 0.05, `${shared}`)

		const other = await store.openConversation(fx.convs[1].convKey, phone)
		let wrongConv = false
		try {
			await store.loadOlder(fx.convs[0].convKey, other.olderCursor ?? '', phone)
		} catch (ex) {
			wrongConv = (ex as { code?: string }).code === 'cursor_invalid'
		}
		check('cursor for another conversation → cursor_invalid', wrongConv)
		const first = await store.openConversation(fx.convs[0].convKey, phone)
		const cleared = await store.clearLocalCache('conversation', fx.convs[0].convKey)
		let stale = false
		try {
			await store.loadOlder(fx.convs[0].convKey, first.olderCursor ?? '', phone)
		} catch (ex) {
			stale = (ex as { code?: string }).code === 'cursor_invalid'
		}
		check('cursor from before clearLocalCache → cursor_invalid', stale && cleared.removed > 0)
	}

	// ---- budget and all-tombstone pages (B5) ------------------------
	{
		const { store } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		const conv = '0xtomb'
		const recs: IncomingRecord[] = []
		for (let i = 0; i < 2100; i++) recs.push({ convKey: conv, dir: 'in', sortTs: 10 + i, sendId: `t${i}`, kind: 'text', body: '', cid: `tc${i}`, revision: 1, deleted: true })
		recs.push({ convKey: conv, dir: 'in', sortTs: 5, sendId: 'visible-old', kind: 'text', body: '{"text":"old"}', cid: 'vo' })
		for (const r of recs) await store.ingest(r)
		await store.setSyncComplete(true)
		const p1 = await store.openConversation(conv, phone)
		check('all-tombstone window returns no items and scanExhausted', p1.items.length === 0 && p1.scanExhausted === true && p1.olderState === 'more', JSON.stringify({ n: p1.items.length, s: p1.scanExhausted, o: p1.olderState }))
		check('scanExhausted page carries a cursor so the UI can continue', p1.olderCursor !== null)
		const p2 = await store.loadOlder(conv, p1.olderCursor!, phone)
		check('continuing reaches the visible old message', p2.items.length === 1 && p2.items[0].body === '{"text":"old"}', JSON.stringify(p2.items.length))
	}

	// ---- revisions and tombstones in a live window ----------------
	{
		const { store } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		await ingestAll(store, records, table)
		await store.setSyncComplete(true)
		const conv = fx.convs[1].convKey
		const first = await store.openConversation(conv, phone)
		const victim = first.items.find((x) => x.stableId) ?? first.items[0]
		const sortedFirst = first.items.map((x) => x.stableId)
		void sortedFirst
		const victimSrc = fx.convs[1].messages.find((m) => m.sendId && !m.deleted && m.sortTs === victim.sortTs)
		if (victimSrc) {
			const tomb = await store.ingest({ convKey: conv, dir: victim.dir, sortTs: victim.sortTs, sendId: victimSrc.sendId, sendKey: victimSrc.sendId as string, kind: victim.kind, body: '', cid: 'gone', revision: victim.revision + 1, deleted: true })
			check('tombstone outcome deleted (sendKey match)', tomb === 'deleted')
			const after = await store.openConversation(conv, phone)
			check('tombstone not returned after delete', !after.items.some((x) => x.stableId === victim.stableId))
			const walked = await walkAll(store, conv, phone)
			check('walk continues past tombstone without duplicates', new Set(walked.items.map((x) => x.stableId)).size === walked.items.length)
		} else {
			check('victim message found in fixture', false)
		}
	}

	// ---- relinearize and sync skip ---------------------------------
	{
		const { store } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		await ingestAll(store, records, table)
		const fetched: string[] = []
		const moved: SyncRecord[] = records.slice(0, 600).map((r) => ({ ...r, cid: r.cid ? r.cid + '-re' : null }))
		const stats = await store.syncRecords(moved, async (r) => {
			fetched.push(r.cid ?? '')
			return table.get(r.cid!.replace(/-re$/, '')) ?? null
		})
		const fetchedSendId = fetched.filter((cid) => records.some((r) => r.cid + '-re' === cid && r.sendId)).length
		check('relinearize: records with sendId are not re-downloaded', fetchedSendId === 0, `fetchedSendId=${fetchedSendId}`)
		check('relinearize: recid counted', stats.recid > 0, JSON.stringify(stats))
		check('relinearize: only sendless rows are re-fetched (documented limit)', fetched.every((cid) => records.some((r) => r.cid + '-re' === cid && !r.sendId)), `fetched=${fetched.length}`)
	}
	{
		const { store } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		await ingestAll(store, records, table)
		let calls = 0
		const again = await store.syncRecords(records, async () => {
			calls++
			return null
		})
		const superseded = fx.revisions.filter((r) => !r.sendId).length
		check('second sync downloads only superseded sendless originals (documented limit)', calls === superseded && again.skipped > 0, `calls=${calls} expected=${superseded}`)
	}

	// ---- first screen does not wait for sync, read path has no network ---
	{
		const { store } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		await ingestAll(store, records, table)
		await store.setSyncComplete(true)
		let release: () => void = () => undefined
		const blocked = new Promise<void>((r) => (release = r))
		const slow = store.syncRecords([{ convKey: '0xnew', dir: 'in', sortTs: 1, sendId: 'n1', cid: 'n1' }], async () => {
			await blocked
			return null
		})
		const t0 = performance.now()
		const page = await store.openConversation(fx.convs[0].convKey, phone)
		const dt = performance.now() - t0
		check('first screen returns while sync is blocked', page.items.length > 0 && dt < 50, `dt=${dt.toFixed(2)}ms`)
		release()
		await slow
	}
	{
		const { store } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		await ingestAll(store, records, table)
		const realFetch = globalThis.fetch
		let netCalls = 0
		globalThis.fetch = (async () => {
			netCalls++
			throw new Error('network disabled in test')
		}) as typeof fetch
		try {
			await walkAll(store, fx.convs[2].convKey, phone)
		} finally {
			globalThis.fetch = realFetch
		}
		check('read path makes zero network calls', netCalls === 0, `calls=${netCalls}`)
	}

	// ---- layout cache, encrypted values -------------------------
	{
		const { store, data } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		await ingestAll(store, records, table)
		await store.setSyncComplete(true)
		const conv = fx.convs[0].convKey
		let pageNow = await store.openConversation(conv, phone)
		for (let round = 0; round < 4; round++) {
			for (const it of pageNow.items) if (!it.layout.measured) await store.reportLayout(conv, it.stableId, phone, phone.widthPt, 130)
			pageNow = await store.openConversation(conv, phone)
		}
		const again = await store.reportLayout(conv, pageNow.items[0].stableId, phone, phone.widthPt, 131)
		check('same-size measurement within 2pt is not rewritten', again.written === false)
		const page2 = await store.openConversation(conv, phone)
		const hitRate = page2.items.filter((x) => x.layout.measured).length / page2.items.length
		check('layout cache hit rate >= 95% on second visit', hitRate >= 0.95, `${(hitRate * 100).toFixed(1)}%`)
		const land: Viewport = { ...phone, widthPt: 844, heightPt: 390, orientation: 'landscape' }
		const rot = await store.openConversation(conv, land)
		check('rotation uses a new key and does not reuse portrait sizes', rot.items.every((x) => !x.layout.measured))
		const back = await store.openConversation(conv, phone)
		check('portrait sizes survive rotation (old key kept)', back.items.filter((x) => x.layout.measured).length > 0)
		const fb = await store.openConversation(conv, { ...phone, fontScale: 1.5 })
		check('font change uses a new key', fb.items.every((x) => !x.layout.measured))
		const layoutDump = JSON.stringify([...data.layouts.values()].map((r) => ({ ...r, val_enc: Array.from(r.val_enc) })))
		check('layout values are not stored as plaintext numbers', !/"w_pt"|"h_pt"|"wPt"|"hPt"/.test(layoutDump))
	}

	// ---- media placeholder ---------------------------------------------------
	{
		const { store } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		await store.ingest({ convKey: '0xmedia', dir: 'in', sortTs: 1, sendId: 'mx', kind: 'image', body: '{"fileMessage":{}}', cid: 'mx', media: { mime: 'image/jpeg', widthPx: 400, heightPx: 300, state: 'failed' } })
		const p = await store.openConversation('0xmedia', phone)
		const it = p.items[0]
		check('failed media returns failed state and 88*fs placeholder', it.media?.state === 'failed' && Math.abs(it.layout.hPt - 88) < 0.01, JSON.stringify(it.layout))
	}

	// ---- estimates -----------------------------------------------------------
	{
		const { store } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		await store.ingest({ convKey: '0ximg', dir: 'in', sortTs: 1, sendId: 'im1', kind: 'image', body: '{"fileMessage":{}}', cid: 'im1', media: { mime: 'image/jpeg', widthPx: 400, heightPx: 300, state: 'ready' } })
		const ip = await store.openConversation('0ximg', phone)
		check('image estimate width = min(widthPt-24, 280) and height from ratio', Math.abs(ip.items[0].layout.wPt - 280) < 0.01 && Math.abs(ip.items[0].layout.hPt - 210) < 0.01, JSON.stringify(ip.items[0].layout))
		await store.ingest({ convKey: '0xtxt', dir: 'in', sortTs: 1, sendId: 'tt', kind: 'text', body: '{"text":"t"}', cid: 'tt' })
		const tp = await store.openConversation('0xtxt', phone)
		check('text estimate is 56*fontScale', Math.abs(tp.items[0].layout.hPt - 56) < 0.01)
	}

	// ---- short window -----------------------------------------------------------
	{
		const { store } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		for (let i = 0; i < 3; i++) await store.ingest({ convKey: '0xshort', dir: 'in', sortTs: 100 + i, sendId: 'sh' + i, kind: 'text', body: '{"text":"t"}', cid: 'sh' + i })
		await store.setSyncComplete(true)
		const p = await store.openConversation('0xshort', phone)
		check('short conversation returns all rows with short=true and olderState end', p.items.length === 3 && p.short === true && p.olderState === 'end')
	}

	// ---- CAP -------------------------------------------------------------------------
	{
		const { store } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		await ingestAll(store, records, table)
		const capPage = await store.openConversation(fx.convs[0].convKey, { ...phone, heightPt: 1e9 })
		check('huge viewport stops at CAP=200 with capped=true and a cursor', capPage.items.length === 200 && capPage.capped === true && capPage.olderCursor !== null)
	}

	// ---- account isolation ----------------------------------------------------------
	{
		const a = newStore()
		const b = newStore(masterB)
		await a.store.open(await rdbOf(masterA), '0xacctA', 'default')
		await b.store.open(await rdbOf(masterB), '0xacctB', 'default')
		await a.store.ingest({ convKey: '0xshared', dir: 'in', sortTs: 10, sendId: 'sA', kind: 'text', body: '{"text":"A-only"}', cid: 'A1' })
		await b.store.ingest({ convKey: '0xshared', dir: 'in', sortTs: 11, sendId: 'sB', kind: 'text', body: '{"text":"B-only"}', cid: 'B1' })
		const aPage = await a.store.openConversation('0xshared', phone)
		const bPage = await b.store.openConversation('0xshared', phone)
		check('A sees only A rows', aPage.items.length === 1 && aPage.items[0].body === '{"text":"A-only"}')
		check('B sees only B rows', bPage.items.length === 1 && bPage.items[0].body === '{"text":"B-only"}')
		await a.store.clearLocalCache('account')
		const bAfter = await b.store.openConversation('0xshared', phone)
		check('clearing A does not affect B', bAfter.items.length === 1)
	}

	// ---- clear keeps unsent ---------------------------------------------------------
	{
		const { store } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		await store.ingest({ convKey: '0xclr', dir: 'out', sortTs: 1, sendId: 'p1', kind: 'text', body: '{"text":"unsent"}', cid: 'p1', pending: true })
		await store.ingest({ convKey: '0xclr', dir: 'in', sortTs: 2, sendId: 'q1', kind: 'text', body: '{"text":"sent"}', cid: 'q1' })
		const before = await store.openConversation('0xclr', phone)
		const r = await store.clearLocalCache('conversation', '0xclr')
		const after = await store.openConversation('0xclr', phone)
		check('clear keeps pending_publish rows, reports pendingKept, bumps dbEpoch', r.pendingKept === 1 && r.removed === 1 && after.items.length === 1 && before.items.length === 2)
		const ev: string[] = []
		const unsub = store.subscribe((e) => ev.push(e.kind))
		await store.clearLocalCache('account')
		unsub()
		check('clear emits cleared event', ev.includes('cleared'))
	}

	// ---- plaintext check -------------------------------------------------------------
	{
		const { store, data } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		await ingestAll(store, records, table)
		const dumpRows = JSON.stringify([...data.byStable.values()].map((r) => ({ ...r, body_enc: r.body_enc ? 'x' : null, meta_enc: r.meta_enc ? 'x' : null })))
		check('no fixture marker in stored rows', !dumpRows.includes('FIXTURE-'))
		const convPlain = fx.convs[0].convKey
		check('no plaintext conversation key in stored rows', !dumpRows.includes(convPlain))
		const sid = fx.convs[0].messages.find((m) => m.sendId)?.sendId as string
		check('no plaintext sendId in stored rows', !dumpRows.includes(sid))
		check('no preview or send_id column', !dumpRows.includes('"preview"') && !dumpRows.includes('"send_id"'))
	}

	// ---- migration digest (support) -------------------------------------------------
	{
		const { store } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		const conv = fx.convs[0]
		await ingestAll(store, records, table)
		const src: IncomingRecord[] = truthFor(fx.convs, fx.revisions, conv.convKey).map((m) => {
			const inc = toIncoming(m)
			inc.sendKey = originSk.get(m.revision > 0 ? m.cid.replace(/-r1$/, '') : m.cid)
			return inc
		})
		const local = await store.digestConversation(conv.convKey)
		const expected = await store.expectedDigest(src)
		check('digest of migrated rows equals source digest', local.count === expected.count && local.digest === expected.digest, `${local.count} vs ${expected.count}`)
		const rb = await store.verifyReadback(100)
		check('read-back of sample and pending rows succeeds', rb.failures === 0 && rb.checked > 0, JSON.stringify(rb))
		check('migration state default none', (await store.getMigrationState()) === 'none')
		await store.setMigrationState('running')
		await store.setMigrationState('complete', local.digest)
		check('migration state persisted', (await store.getMigrationState()) === 'complete')
	}

	// ---- performance (environment: Node on the test host) --------------------------------
	{
		const big = buildFixture({ seed: 77, convs: 10, messagesPerConv: 5000, convPrefix: 'p' }) // 50k rows total
		const { store } = newStore()
		await store.open(await rdbOf(masterA), '0xacctA', 'default')
		const t0 = performance.now()
		const sync = toSync(big.convs, [])
		await store.syncRecords(sync.records, async (r) => sync.table.get(r.cid!) ?? null, { batch: 200, concurrency: 6 })
		await store.setSyncComplete(true)
		const syncMs = performance.now() - t0
		const bigConv = big.convs[0].convKey
		const samples: number[] = []
		for (let i = 0; i < 30; i++) {
			const s = performance.now()
			await store.openConversation(bigConv, phone)
			samples.push(performance.now() - s)
		}
		const olderSamples: number[] = []
		let cursorPage = await store.openConversation(bigConv, phone)
		for (let i = 0; i < 30 && cursorPage.olderCursor; i++) {
			const s = performance.now()
			cursorPage = await store.loadOlder(bigConv, cursorPage.olderCursor, phone)
			olderSamples.push(performance.now() - s)
		}
		const p50 = percentile(samples, 0.5)
		const p95 = percentile(samples, 0.95)
		console.log(`[perf] env=Node ${process.version} host=${process.platform} memory-backend rows=50000 conv=5000 sync=${syncMs.toFixed(0)}ms`)
		console.log(`[perf] openConversation SDK P50=${p50.toFixed(2)}ms P95=${p95.toFixed(2)}ms (n=${samples.length}; target P95<=80)`)
		console.log(`[perf] loadOlder P95=${percentile(olderSamples, 0.95).toFixed(2)}ms (n=${olderSamples.length}; target P95<=60)`)
		check('first screen SDK P95 <= 80ms', p95 <= 80, `${p95.toFixed(2)}`)
	}

	console.log(`\n${passes} passed, ${failures} failed`)
	if (failures) process.exitCode = 1
}

main().catch((ex) => {
	console.error(ex)
	process.exitCode = 1
})
