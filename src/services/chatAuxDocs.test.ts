/**
 * @jest-environment node
 */
// which chat documents the page adapter may remove, and which of them the explicit local wallet reset wipes (chatAuxDocs.ts).
import { readFileSync } from 'fs'
import { join } from 'path'
import { CHAT_AUX_DOC_ID, UNSENT_PREFIXES, WIPED_ON_RESET_PREFIXES, canConfirmReset, hasUnsent, isChatAuxDocId, readUnsentSummary, resetPrefixes, unsentWarningLines, wipeChatAuxDocs, type ChatAuxWipeAdapter } from './chatAuxDocs'

const EOA = '0xaaaa000000000000000000000000000000000001'
const OTHER = '0xbbbb000000000000000000000000000000000002'
const src = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')

function disk(ids: string[]) {
	const docs = new Set(ids)
	let failRemove: ((id: string) => boolean) | null = null
	let failList: ((prefix: string) => boolean) | null = null
	const adapter: ChatAuxWipeAdapter = {
		list: async (prefix) => { if (failList?.(prefix)) throw new Error('list_failed'); return [...docs].filter((k) => k.startsWith(prefix)).sort() },
		remove: async (id) => { if (failRemove?.(id)) throw new Error('remove_failed'); docs.delete(id) },
	}
	return { docs, adapter, failRemove: (f: typeof failRemove) => { failRemove = f }, failList: (f: typeof failList) => { failList = f } }
}
const FULL = [
	`chat-draft-v1:${EOA}`,
	`chat-queue-v1:${EOA}:s1`,
	`chat-queue-v1:${OTHER}:s2`,
	`chat-receipt-v1:${EOA}:${'a'.repeat(32)}:${'b'.repeat(32)}`,
	`chat-receipt-v1:${OTHER}:${'c'.repeat(32)}:${'d'.repeat(32)}`,
	`chat-delivered-v1:${EOA}:${'a'.repeat(32)}:${'b'.repeat(32)}`,
	'init',
	'meta',
]

describe('the ids the chat page adapter may remove', () => {
	it('draft, queue, receipt and delivered documents are removable; `init`, `meta` and anything else are refused', () => {
		for (const id of FULL.filter((i) => i.startsWith('chat-'))) expect(isChatAuxDocId(id)).toBe(true)
		for (const id of ['init', 'meta', 'vault', 'chat-other-v1:x', 'xchat-queue-v1:x', 'chat-receipt-v2:x', '', 'chat-receipt-v1']) expect(isChatAuxDocId(id)).toBe(false)
		expect(CHAT_AUX_DOC_ID.source).toContain('receipt')
		expect(CHAT_AUX_DOC_ID.source).toContain('delivered')
	})
	it('beamio.ts removes through that one rule and no longer names only draft and queue', () => {
		const beamio = src('beamio.ts')
		expect(beamio).toMatch(/const removeChatAuxDoc = async \(docId: string\): Promise<void> => \{\s*if \(!isChatAuxDocId\(docId\)\) throw new Error\('not_a_chat_aux_doc'\)/)
		expect(beamio).not.toMatch(/\^chat-\(draft\|queue\)-v1:/)
	})
})

describe('the explicit local wallet reset wipes the receipt and delivered documents', () => {
	it('every receipt and delivered document of every account goes; the draft and queue documents, `init` and `meta` are not touched by this step', async () => {
		const d = disk(FULL)
		expect(await wipeChatAuxDocs(d.adapter)).toBe(3)
		expect([...d.docs].sort()).toEqual([`chat-draft-v1:${EOA}`, `chat-queue-v1:${EOA}:s1`, `chat-queue-v1:${OTHER}:s2`, 'init', 'meta'].sort())
		expect([...WIPED_ON_RESET_PREFIXES]).toEqual(['chat-receipt-v1:', 'chat-delivered-v1:'])
	})
	it('nothing to wipe is zero and not an error', async () => {
		expect(await wipeChatAuxDocs(disk([`chat-queue-v1:${EOA}:s1`, 'init']).adapter)).toBe(0)
	})
	it('a failing removal does not stop the others, and the wipe then REJECTS so the reset can say that data may remain; a failing list is the same', async () => {
		const d = disk(FULL)
		d.failRemove((id) => id.startsWith(`chat-receipt-v1:${EOA}:`))
		await expect(wipeChatAuxDocs(d.adapter)).rejects.toThrow('remove_failed')
		expect(d.docs.has(`chat-receipt-v1:${EOA}:${'a'.repeat(32)}:${'b'.repeat(32)}`)).toBe(true) // the one that failed stays
		expect(d.docs.has(`chat-receipt-v1:${OTHER}:${'c'.repeat(32)}:${'d'.repeat(32)}`)).toBe(false) // the others were still tried
		expect(d.docs.has(`chat-delivered-v1:${EOA}:${'a'.repeat(32)}:${'b'.repeat(32)}`)).toBe(false)
		const e = disk(FULL)
		e.failList((p) => p.startsWith('chat-receipt-v1:'))
		await expect(wipeChatAuxDocs(e.adapter)).rejects.toThrow('list_failed')
		expect([...e.docs].some((i) => i.startsWith('chat-delivered-v1:'))).toBe(false) // the other class was still wiped
	})
	it('wipeLocalWalletForRestore runs the wipe BEFORE it removes the wallet records, through the same adapter rules, so a failed wipe leaves the wallet as it was', () => {
		const beamio = src('beamio.ts')
		const at = beamio.indexOf('export const wipeLocalWalletForRestore')
		const body = beamio.slice(at, beamio.indexOf('\n}\n', at))
		const wipe = body.indexOf('await wipeChatAuxDocs({ list: (prefix) => listDocIds(prefix), remove: (docId) => removeChatAuxDoc(docId) }, resetPrefixes(options?.includeUnsent === true))')
		const init = body.indexOf("for (const id of ['init', 'meta']) await removeDocIfExists(id)")
		expect(wipe).toBeGreaterThan(0)
		expect(init).toBeGreaterThan(wipe)
	})
})

describe('the other flows that could clear these documents', () => {
	it('the only wipe of the device wallet is wipeLocalWalletForRestore (PasscodeLockScreen reset); sign-out ("Lock") and the library switch / purge delete no chat document: a sign-out must keep the queue, the receipts and the delivered marks', () => {
		for (const rel of ['signOutLocal.ts', 'chatLocalMigration.ts', 'chatLocalMigrationCore.ts', 'chatLocalPurge.ts', 'recordBodyCleanup.ts']) {
			const text = src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
			expect(text).not.toMatch(/removeChatAuxDoc|chatDraftDocAdapter|chat-(queue|receipt|delivered|draft)-v1|wipeChatAuxDocs/)
		}
		const callers = ['../components/PasscodeLockScreen.tsx'].map((rel) => src(rel))
		expect(callers[0]).toMatch(/await wipeLocalWalletForRestore\(\{ includeUnsent:/)
	})
	it('the receipt and delivered documents are reachable by no other path that deletes a wallet: nothing but wipeLocalWalletForRestore removes `init`', () => {
		const beamio = src('beamio.ts')
		expect([...beamio.matchAll(/removeDocIfExists\(/g)].length).toBeGreaterThan(0)
		expect(beamio.match(/export const wipeLocalWalletForRestore/g)?.length).toBe(1)
	})
})

describe('the reset and the messages never sent: count, effect, cancel, delete only after the user confirmed', () => {
	it('the summary counts queue documents from the ids alone (an unreadable queue document counts too) and flags a draft; a failing listing is "unknown", never "nothing"', async () => {
		const d = disk([...FULL, `chat-queue-v1:${EOA}:s3`])
		expect(await readUnsentSummary(d.adapter)).toEqual({ queued: 3, hasDraft: true, unknown: false, unarchived: 'unknown' })
		expect(await readUnsentSummary(disk(['init']).adapter)).toEqual({ queued: 0, hasDraft: false, unknown: false, unarchived: 'unknown' })
		const e = disk(FULL)
		e.failList(() => true)
		expect(await readUnsentSummary(e.adapter)).toEqual({ queued: 0, hasDraft: false, unknown: true, unarchived: 'unknown' })
		expect(await readUnsentSummary(disk(['init']).adapter, async () => 4)).toMatchObject({ unarchived: 4 })
		for (const bad of [async () => { throw new Error('x') }, async () => -1, async () => 1.5]) expect((await readUnsentSummary(disk(['init']).adapter, bad as () => Promise<number>)).unarchived).toBe('unknown')
		expect(await readUnsentSummary(undefined)).toMatchObject({ unknown: true })
	})
	it('hasUnsent: queued, a draft or an unknown state asks for the extra confirmation; nothing unsent does not', () => {
		expect(hasUnsent({ queued: 0, hasDraft: false, unknown: false })).toBe(false)
		expect(hasUnsent({ queued: 1, hasDraft: false, unknown: false })).toBe(true)
		expect(hasUnsent({ queued: 0, hasDraft: true, unknown: false })).toBe(true)
		expect(hasUnsent({ queued: 0, hasDraft: false, unknown: true })).toBe(true)
	})
	it('the confirm button: needs the generic confirmation, a known summary, and (when something is unsent) the extra confirmation; never while busy', () => {
		const none = { queued: 0, hasDraft: false, unknown: false, unarchived: 0 }
		const some = { queued: 2, hasDraft: false, unknown: false, unarchived: 0 }
		// only unsaved history, or a history state that cannot be told, asks for the extra confirmation too; it never blocks the reset for good
		for (const unarchived of [3, 'unknown'] as const) {
			expect(canConfirmReset({ confirmGeneric: true, confirmUnsent: false, summary: { ...none, unarchived }, busy: false })).toBe(false)
			expect(canConfirmReset({ confirmGeneric: true, confirmUnsent: true, summary: { ...none, unarchived }, busy: false })).toBe(true)
		}
		expect(canConfirmReset({ confirmGeneric: true, confirmUnsent: false, summary: none, busy: false })).toBe(true) // nothing unsent: the flow is as before
		expect(canConfirmReset({ confirmGeneric: false, confirmUnsent: true, summary: none, busy: false })).toBe(false)
		expect(canConfirmReset({ confirmGeneric: true, confirmUnsent: false, summary: some, busy: false })).toBe(false)
		expect(canConfirmReset({ confirmGeneric: true, confirmUnsent: true, summary: some, busy: false })).toBe(true)
		expect(canConfirmReset({ confirmGeneric: true, confirmUnsent: true, summary: null, busy: false })).toBe(false) // not read yet
		expect(canConfirmReset({ confirmGeneric: true, confirmUnsent: true, summary: some, busy: true })).toBe(false)
	})
	it('the warning names the count (singular and plural), says they will never be sent, and says Back deletes nothing', () => {
		const one = unsentWarningLines({ queued: 1, hasDraft: false, unknown: false })
		expect(one.headline).toContain('1 message that has not been sent')
		const many = unsentWarningLines({ queued: 3, hasDraft: true, unknown: false })
		expect(many.headline).toContain('3 messages that have not been sent')
		expect(many.headline).toContain('typed')
		expect(one.effect).toMatch(/deleted from this device and will never be sent/)
		expect(one.effect).toMatch(/Back to cancel: nothing is deleted/)
		expect(unsentWarningLines({ queued: 0, hasDraft: false, unknown: true }).headline).toMatch(/could not check/)
	})
	it('without the user\'s confirmation the queue and draft documents are untouched; with it they go with the receipt and delivered documents; `init`-class ids are never in any list', async () => {
		expect([...resetPrefixes(false)]).toEqual([...WIPED_ON_RESET_PREFIXES])
		expect([...resetPrefixes(true)]).toEqual([...WIPED_ON_RESET_PREFIXES, ...UNSENT_PREFIXES])
		const cancelled = disk(FULL)
		await wipeChatAuxDocs(cancelled.adapter, resetPrefixes(false))
		expect([...cancelled.docs].filter((i) => i.startsWith('chat-queue-v1:') || i.startsWith('chat-draft-v1:')).length).toBe(3)
		const confirmed = disk(FULL)
		await wipeChatAuxDocs(confirmed.adapter, resetPrefixes(true))
		expect([...confirmed.docs].sort()).toEqual(['init', 'meta'])
	})
	it('beamio.ts only removes the unsent classes when the caller passes includeUnsent, and the lock screen passes it only after the extra confirmation', () => {
		const beamio = src('beamio.ts')
		expect(beamio).toMatch(/wipeLocalWalletForRestore = async \(options\?: \{ includeUnsent\?: boolean \}\)/)
		const screen = src('../components/PasscodeLockScreen.tsx')
		expect(screen).toMatch(/await wipeLocalWalletForRestore\(\{ includeUnsent: unsent !== null && hasUnsent\(unsent\) && confirmUnsent \}\)/)
		expect(screen).toMatch(/if \(!canConfirmReset\(\{ confirmGeneric: confirmReset, confirmUnsent, summary: unsent, busy \}\)\) return/)
	})
})
