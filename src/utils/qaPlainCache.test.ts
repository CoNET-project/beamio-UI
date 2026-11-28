// the read-only counts of the first-copy question (qaPlainCache.ts) and the first-copy event in chat.tsx. Hook variant only.
import { readFileSync } from 'fs'
import { join } from 'path'
import { QA_PLAIN_CACHE_PREFIX, qaClearPlainCache, qaClearPlainCacheForOwner, qaOwnerEoaOf, qaPlainCacheKeyCount, qaPlainPurgeEventsOf, qaSetPlainCacheOwner } from './qaPlainCache'

const src = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')

/** a fake IndexedDB that follows the calls the helper makes: open, the store, a bounded count on a read-only transaction */
function fakeIdb(keys: string[], opts: { storeExists?: boolean; openError?: boolean; countError?: boolean } = {}) {
	const calls: string[] = []
	const factory = {
		open: (name: string) => {
			calls.push(`open:${name}`)
			const req: Record<string, unknown> = { result: null }
			setTimeout(() => {
				if (opts.openError) { (req.onerror as () => void)?.(); return }
				req.result = {
					objectStoreNames: { contains: (n: string) => (opts.storeExists ?? true) && n === 'kv' },
					close: () => { calls.push('close') },
					transaction: (store: string, mode: string) => {
						calls.push(`tx:${store}:${mode}`)
						return {
							objectStore: () => ({
								count: (range: { lower: string; upper: string }) => {
									calls.push(`count:${range.lower}`)
									const c: Record<string, unknown> = { result: keys.filter((k) => k >= range.lower && k <= range.upper).length }
									setTimeout(() => (opts.countError ? (c.onerror as () => void)?.() : (c.onsuccess as () => void)?.()), 0)
									return c
								},
							}),
						}
					},
				}
				;(req.onsuccess as () => void)?.()
			}, 0)
			return req
		},
	}
	return { factory: factory as unknown as IDBFactory, calls }
}

describe('qaPlainCacheKeyCount', () => {
	beforeAll(() => {
		;(globalThis as unknown as { IDBKeyRange: unknown }).IDBKeyRange = { bound: (lower: string, upper: string) => ({ lower, upper }) }
	})
	it('counts only the plaintext history-cache keys, with a read-only transaction on the worker database, and closes it', async () => {
		const f = fakeIdb([`${QA_PLAIN_CACHE_PREFIX}0xabc:cid1`, `${QA_PLAIN_CACHE_PREFIX}0xabc:cid2`, 'beamio.chat.history.frag:0xabc:cid1', 'other'])
		await expect(qaPlainCacheKeyCount(f.factory)).resolves.toBe(2)
		expect(f.calls).toEqual(['open:beamio-chat-sdk', 'tx:kv:readonly', `count:${QA_PLAIN_CACHE_PREFIX}`, 'close'])
	})
	it('no plaintext keys is 0; a missing store is 0; an unreadable database is -1; no IndexedDB is -1', async () => {
		await expect(qaPlainCacheKeyCount(fakeIdb(['x']).factory)).resolves.toBe(0)
		await expect(qaPlainCacheKeyCount(fakeIdb([], { storeExists: false }).factory)).resolves.toBe(0)
		await expect(qaPlainCacheKeyCount(fakeIdb([], { openError: true }).factory)).resolves.toBe(-1)
		await expect(qaPlainCacheKeyCount(fakeIdb(['x'], { countError: true }).factory)).resolves.toBe(-1)
		await expect(qaPlainCacheKeyCount({ open: () => { throw new Error('x') } } as unknown as IDBFactory)).resolves.toBe(-1)
	})
	it('the module returns a number only: no read of a value, no write, no log', () => {
		const code = src('qaPlainCache.ts').split('/** the account whose plaintext cache')[0].replace(/\/\*[\s\S]*?\*\//g, '') // the READ-ONLY count; the QA clear below it is the one writer, tested separately
		expect(code).not.toMatch(/\.get\(|\.getAll\(|\.put\(|\.add\(|\.delete\(|readwrite|console\.|localStorage|fetch\(/)
	})
})

describe('the first-copy event in chat.tsx (hook variant only)', () => {
	const chat = src('../pages/chat/chat.tsx')
	it('fires once per mount, when the first message shows, behind the compile-time switch', () => {
		expect(chat).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK !== 'true' \|\| qaFirstCopyRef\.current \|\| messages\.length === 0\) return\s*qaFirstCopyRef\.current = true/)
	})
	it('the boolean comes from the stored-record SNAPSHOT taken at the mount (before the first message and the page\'s own persistence), only true or false is emitted, and the plaintext key count is a number', () => {
		const snapAt = chat.indexOf('const qaRecordSnapshotRef = useRef<Promise<Set<string>> | null>(null)')
		const firstAt = chat.indexOf('const qaFirstCopyRef = useRef(false)')
		expect(snapAt).toBeGreaterThan(firstAt)
		expect(chat).toMatch(/qaRecordSnapshotRef\.current = \(async \(\) => \{/)
		expect(chat).toMatch(/for \(const m of chat\?\.messages \?\? \[\]\) if \(typeof m\?\.sendId === 'string' && typeof m\.text === 'string' && m\.text\.length > 0\) ids\.add\(m\.sendId\)/)
		// the snapshot effect comes BEFORE the first-copy effect (same commit, earlier run), and the first-copy effect reads the snapshot, not the record
		expect(chat.indexOf('qaRecordSnapshotRef.current = (async')).toBeLessThan(chat.indexOf('if (process.env.REACT_APP_QA_ACK_ORDER_HOOK !== \'true\' || qaFirstCopyRef.current || messages.length === 0) return'))
		expect(chat).toMatch(/const snapshot = \(await qaRecordSnapshotRef\.current\) \?\? new Set<string>\(\)\s*\n\s*for \(const id of shownIds\) if \(snapshot\.has\(id\)\) recordIds\.add\(id\)\s*\n\s*recordHasBody = recordIds\.size > 0/)
		expect(chat).toMatch(/qaEvent\('first_copy_record_body', undefined, `rec_\$\{recordHasBody \? 'true' : 'false'\}`\)/)
		expect(chat).toMatch(/qaEvent\('first_copy_plain_keys', undefined, `n\$\{Math\.max\(0, await qaPlainCacheKeyCount\(\)\)\}`\)/)
		const at = chat.indexOf('const qaFirstCopyRef = useRef(false)')
		const block = chat.slice(at, at + 4800)
		expect(block).not.toMatch(/console\./)
		expect(block).not.toMatch(/qaEvent\([^)]*(m\.text|\.text\b)/)
	})
	it('the number events keep their digits (the event detail allows a-z, 0-9 and _)', async () => {
		const prev = process.env.REACT_APP_QA_ACK_ORDER_HOOK
		process.env.REACT_APP_QA_ACK_ORDER_HOOK = 'true'
		jest.resetModules()
		const qa = await import('./qaAckOrder')
		qa.qaEvent('first_copy_plain_keys', undefined, 'n42')
		qa.qaEvent('plain_cache_cleared', undefined, 'b12_a0')
		const xs = qa.qaEventList().filter((e) => e.n === 'first_copy_plain_keys' || e.n === 'plain_cache_cleared').map((e) => e.x)
		expect(xs).toEqual(['n42', 'b12_a0'])
		if (prev === undefined) delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
		else process.env.REACT_APP_QA_ACK_ORDER_HOOK = prev
	})
})


/** a fake worker database with a real key space: count and delete by key range, so the clear's before / after numbers mean something */
function fakeKv(initial: string[], opts: { deleteError?: boolean; noopDelete?: boolean } = {}) {
	const keys = new Set(initial)
	const calls: string[] = []
	const factory = {
		open: () => {
			const req: Record<string, unknown> = { result: null }
			setTimeout(() => {
				req.result = {
					objectStoreNames: { contains: (n: string) => n === 'kv' },
					close: () => undefined,
					transaction: (_store: string, mode: string) => {
						calls.push(`tx:${mode}`)
						const tx: Record<string, unknown> = {}
						tx.objectStore = () => ({
							count: (range: { lower: string; upper: string }) => {
								const c: Record<string, unknown> = { result: [...keys].filter((k) => k >= range.lower && k <= range.upper).length }
								setTimeout(() => (c.onsuccess as () => void)?.(), 0)
								return c
							},
							delete: (range: { lower: string; upper: string }) => {
								calls.push(`delete:${range.lower}`)
								if (!opts.deleteError && !opts.noopDelete) for (const k of [...keys]) if (k >= range.lower && k <= range.upper) keys.delete(k)
								setTimeout(() => ((opts.deleteError ? tx.onerror : tx.oncomplete) as () => void)?.(), 0)
							},
						})
						return tx
					},
				}
				;(req.onsuccess as () => void)?.()
			}, 0)
			return req
		},
	}
	return { factory: factory as unknown as IDBFactory, keys, calls }
}

describe('qaClearPlainCache (the QA control round)', () => {
	const A = '0x' + 'aa'.repeat(20)
	const B = '0x' + 'bb'.repeat(20)
	beforeAll(() => {
		;(globalThis as unknown as { IDBKeyRange: unknown }).IDBKeyRange = { bound: (lower: string, upper: string) => ({ lower, upper }) }
	})
	it('deletes only the plaintext keys of THIS account, leaves every other key (another account, the history fragments, the library), and reports the numbers before and after', async () => {
		const other = ['beamio.chat.history.frag:' + A + ':c1', 'library:state', `${QA_PLAIN_CACHE_PREFIX}${B}:c9`]
		const f = fakeKv([`${QA_PLAIN_CACHE_PREFIX}${A}:c1`, `${QA_PLAIN_CACHE_PREFIX}${A}:c2`, `${QA_PLAIN_CACHE_PREFIX}${A}:c3`, ...other])
		await expect(qaClearPlainCache(A, f.factory)).resolves.toEqual({ ok: true, before: 3, after: 0 })
		expect([...f.keys].sort()).toEqual([...other].sort())
		expect(f.calls).toContain(`delete:${QA_PLAIN_CACHE_PREFIX}${A}:`)
	})
	it('the owner is the EOA the chat client is bound to; a keyID that is not a bare address still yields its address, one without an address is skipped (r8hook3 smoke: no_account)', () => {
		const eoa = '0x' + 'Ab'.repeat(20)
		expect(qaOwnerEoaOf([eoa])).toBe(eoa.toLowerCase())
		expect(qaOwnerEoaOf([null, 'not-an-address', `${eoa}:workspace-1`])).toBe(eoa.toLowerCase()) // eoa:workspace form
		expect(qaOwnerEoaOf([A, B])).toBe(A) // the bound account wins over the keyID
		expect(qaOwnerEoaOf([undefined, 'KEY-ID-ABCDEF0123', 7, {}])).toBe('')
		expect(qaOwnerEoaOf(['0x' + 'a'.repeat(41)])).toBe('') // 41 hex digits is not an address
		expect(qaOwnerEoaOf([])).toBe('')
	})
	it('the clear through the registered owner works when the keyID is NOT a bare address: after it the key count of the range is 0 and the other keys stay', async () => {
		const f = fakeKv([`${QA_PLAIN_CACHE_PREFIX}${A}:c1`, `${QA_PLAIN_CACHE_PREFIX}${A}:c2`, `${QA_PLAIN_CACHE_PREFIX}${B}:c3`, 'beamio.chat.history.frag:x'])
		const realIdb = (globalThis as unknown as { indexedDB?: unknown }).indexedDB
		;(globalThis as unknown as { indexedDB: unknown }).indexedDB = f.factory
		try {
			const events: string[] = []
			qaSetPlainCacheOwner(() => qaOwnerEoaOf([A, 'profile-key-id-not-an-address']))
			await expect(qaClearPlainCacheForOwner((n, d) => events.push(`${n}:${d}`))).resolves.toEqual({ ok: true, before: 2, after: 0 })
			expect(events).toEqual(['plain_cache_cleared:b2_a0'])
			expect([...f.keys].filter((k) => k.startsWith(`${QA_PLAIN_CACHE_PREFIX}${A}:`))).toEqual([]) // the range is empty
			expect([...f.keys].sort()).toEqual([`${QA_PLAIN_CACHE_PREFIX}${B}:c3`, 'beamio.chat.history.frag:x'].sort())
			// the old owner (a keyID that is no address, nothing bound) is what answered no_account
			qaSetPlainCacheOwner(() => qaOwnerEoaOf([null, 'profile-key-id-not-an-address']))
			await expect(qaClearPlainCacheForOwner()).resolves.toEqual({ ok: false, reason: 'no_account' })
		} finally {
			;(globalThis as unknown as { indexedDB: unknown }).indexedDB = realIdb
			qaSetPlainCacheOwner(null)
		}
	})
	it('the AFTER number is read from the database again: a delete that did not take shows after > 0 (the numbers are the evidence)', async () => {
		const f = fakeKv([`${QA_PLAIN_CACHE_PREFIX}${A}:c1`, `${QA_PLAIN_CACHE_PREFIX}${A}:c2`], { noopDelete: true })
		await expect(qaClearPlainCache(A, f.factory)).resolves.toEqual({ ok: true, before: 2, after: 2 })
	})
	it('nothing to delete: before 0 after 0 and no write transaction is opened', async () => {
		const f = fakeKv(['x'])
		await expect(qaClearPlainCache(A, f.factory)).resolves.toEqual({ ok: true, before: 0, after: 0 })
		expect(f.calls.filter((c) => c === 'tx:readwrite')).toEqual([])
	})
	it('no valid account, no IndexedDB, and a delete that fails each say why (never a silent success)', async () => {
		await expect(qaClearPlainCache('', fakeKv([]).factory)).resolves.toEqual({ ok: false, reason: 'no_account' })
		await expect(qaClearPlainCache('0x12', fakeKv([]).factory)).resolves.toEqual({ ok: false, reason: 'no_account' })
		await expect(qaClearPlainCache(A, undefined as never)).resolves.toMatchObject({ ok: false })
		const f = fakeKv([`${QA_PLAIN_CACHE_PREFIX}${A}:c1`], { deleteError: true })
		await expect(qaClearPlainCache(A, f.factory)).resolves.toEqual({ ok: false, reason: 'delete_failed' })
	})
	it('the clear is hook-only wiring: the button is mounted behind the compile-time switch, the owner is the App\'s account, and the module deletes by the account key range only', () => {
		expect(src('../index.tsx')).toMatch(/\{process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && <QaPlainCacheClear \/>\}/)
		expect(src('../App.tsx')).toMatch(/qaSetPlainCacheOwner\(\(\) => qaOwnerEoaOf\(\[boundAccountOfActiveClient\(\), CoNET_Data\?\.profiles\?\.\[0\]\?\.keyID\]\)\)/)
		expect(src('qaAckOrder.ts')).toMatch(/clearPlainCache: \(\) => qaClearPlainCacheForOwner\(/)
		const code = src('qaPlainCache.ts').replace(/\/\*[\s\S]*?\*\//g, '')
		expect(code).toMatch(/const prefix = `\$\{QA_PLAIN_CACHE_PREFIX\}\$\{eoa\}:`/)
		expect(code).toMatch(/\.delete\(IDBKeyRange\.bound\(prefix, `\$\{prefix\}\uffff`\)\)/)
		expect(code).not.toMatch(/\.clear\(|deleteDatabase|\.put\(|\.add\(/)
	})
})

describe('the worker purge line becomes count events (junk readable on a real account)', () => {
	const line = (o: Partial<Record<string, string | number>> = {}) => `[local] legacy plain purge status=${o.status ?? 'purged'} reason=${o.reason ?? ''} keys=${o.keys ?? 12} rows=${o.rows ?? 11} inserted=${o.inserted ?? 3} present=${o.present ?? 8} junk=${o.junk ?? 1} removed=${o.removed ?? 12} remaining=${o.remaining ?? 0}`
	it('a purge line gives the status event and the counts event with junk in it', () => {
		expect(qaPlainPurgeEventsOf(line())).toEqual([{ name: 'plain_purge', detail: 'purged' }, { name: 'plain_purge_n', detail: 'k12_j1_i3_r12_l0' }])
		expect(qaPlainPurgeEventsOf(line({ status: 'blocked', reason: 'read_failed', remaining: -1, junk: 0 }))).toEqual([{ name: 'plain_purge', detail: 'blocked_read_failed' }, { name: 'plain_purge_n', detail: 'k12_j0_i3_r12_lm1' }])
	})
	it('any other message (or a line with more fields) gives no event; only numbers and plain words can come out', () => {
		expect(qaPlainPurgeEventsOf('[local] migration purged plain keys=3')).toEqual([])
		expect(qaPlainPurgeEventsOf(`${line()} body=SECRET`)).toEqual([])
		expect(qaPlainPurgeEventsOf(undefined)).toEqual([])
		for (const e of qaPlainPurgeEventsOf(line({ reason: 'ingest_conflict' }))) expect(e.detail).toMatch(/^[a-z0-9_]+$/)
	})
	it('the digits survive the event detail up to 24 characters, and the bridge forwards the line only in the hook variant', async () => {
		const prev = process.env.REACT_APP_QA_ACK_ORDER_HOOK
		process.env.REACT_APP_QA_ACK_ORDER_HOOK = 'true'
		jest.resetModules()
		const qa = await import('./qaAckOrder')
		qa.qaEvent('plain_purge_n', undefined, 'k1200_j0_i0_r1200_lm1')
		expect(qa.qaEventList().filter((e) => e.n === 'plain_purge_n').map((e) => e.x)).toEqual(['k1200_j0_i0_r1200_lm1'])
		if (prev === undefined) delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
		else process.env.REACT_APP_QA_ACK_ORDER_HOOK = prev
		expect(src('../services/chatWorkerBridge.ts')).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'\) for \(const e of qaPlainPurgeEventsOf\(l\.message\)\) qaEvent\(e\.name, undefined, e\.detail\)/)
	})
})
