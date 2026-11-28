/**
 * @jest-environment node
 */
// bodies that were put back into the account record are removed only after the library confirms it holds them, one message at a time, read back, with a rollback.
import { cleanRecordBodies, type CleanupDeps } from './recordBodyCleanup'
import { countChatMessages, stripChatBodiesFromProfiles } from './chatLocalPurge'

const EOA = '0x1111111111111111111111111111111111111111'
const A = '0xaaaa000000000000000000000000000000000001'
const B = '0xbbbb000000000000000000000000000000000002'
const msg = (sendId: string | undefined, text: string) => ({ id: `id-${sendId ?? text}`, ...(sendId ? { sendId } : {}), from: 'me', text, createdAt: 1, status: 'sent' })
const profiles = (): unknown[] => [{
	keyID: EOA, privateKeyArmor: 'SYNTHETIC-ARMOR', title: 'p',
	chats: [
		{ address: A, unreadCount: 0, preview: 'p-a', lastMessage: 'l-a', messages: [msg('a1', 'BODY-A1'), msg('a2', 'BODY-A2'), msg(undefined, 'BODY-NO-SENDID')] },
		{ address: B, unreadCount: 0, preview: 'p-b', messages: [msg('b1', 'BODY-B1')] },
	],
}]

function rig(opts: { library?: Record<string, string[] | null>; persistOk?: boolean; readBack?: 'same' | 'missing' | 'unstripped' | 'lostmore' | 'fingerprint'; persistThrows?: boolean } = {}) {
	let live = profiles()
	let stored: unknown[] = profiles()
	const calls: string[] = []
	const original = live
	const deps: CleanupDeps = {
		liveProfiles: () => live,
		setLiveProfiles: (p) => { live = p; calls.push(p === original ? 'set:original' : 'set:stripped') },
		libraryHas: async (peer, ids) => {
			calls.push(`has:${peer.slice(-3)}:${ids.join(',')}`)
			const l = (opts.library ?? { [A]: ['a1', 'a2'], [B]: ['b1'] })[peer]
			return l === undefined ? new Set() : l === null ? null : new Set(l.filter((x) => ids.includes(x)))
		},
		persistProfiles: async () => {
			calls.push('persist')
			if (opts.persistThrows && live !== original) throw new Error('boom')
			if (opts.persistOk === false && live !== original) return false
			stored = live
			return true
		},
		readStoredProfiles: async () => {
			calls.push('readback')
			if (opts.readBack === 'missing') return null
			if (opts.readBack === 'unstripped') return profiles()
			if (opts.readBack === 'lostmore') return stripChatBodiesFromProfiles(profiles())
			if (opts.readBack === 'fingerprint') return (stored as Array<Record<string, unknown>>).map((p) => ({ ...p, title: 'CHANGED' }))
			return stored
		},
	}
	return { deps, calls, getLive: () => live, getStored: () => stored, original }
}

describe('cleanRecordBodies', () => {
	it('removes exactly the messages the library confirmed: a message without a sendId and one the library did not confirm stay; the previews go only with the last body of a conversation', async () => {
		const r = rig({ library: { [A]: ['a1'], [B]: ['b1'] } })
		const res = await cleanRecordBodies(r.deps)
		expect(res).toEqual({ ok: true, stripped: 2, kept: 2, skippedChats: 0 })
		const out = JSON.stringify(r.getStored())
		expect(out).not.toContain('BODY-A1')
		expect(out).toContain('BODY-A2') // the library did not confirm a2
		expect(out).toContain('BODY-NO-SENDID') // no sendId, cannot be confirmed
		expect(out).not.toContain('BODY-B1')
		const chats = (r.getStored()[0] as { chats: Array<Record<string, unknown>> }).chats
		expect(chats[0].preview).toBe('p-a') // bodies remain in chat A: the preview stays
		expect(chats[1].preview).toBeUndefined() // chat B has none left: its preview goes
		expect(countChatMessages(r.getStored())).toBe(2)
	})
	it('the library cannot answer (null) for a conversation: that conversation is kept whole; the others are still handled', async () => {
		const r = rig({ library: { [A]: null, [B]: ['b1'] } })
		const res = await cleanRecordBodies(r.deps)
		expect(res).toEqual({ ok: true, stripped: 1, kept: 3, skippedChats: 1 })
		expect(JSON.stringify(r.getStored())).toContain('BODY-A1')
	})
	it('the library confirms nothing: nothing is written at all', async () => {
		const r = rig({ library: { [A]: [], [B]: [] } })
		const res = await cleanRecordBodies(r.deps)
		expect(res).toEqual({ ok: true, stripped: 0, kept: 4, skippedChats: 0 })
		expect(r.calls.filter((c) => c === 'persist')).toEqual([])
		expect(r.getLive()).toBe(r.original)
	})
	it('a record without bodies: nothing to do', async () => {
		const r = rig()
		r.deps.setLiveProfiles(stripChatBodiesFromProfiles(profiles()))
		expect(await cleanRecordBodies(r.deps)).toEqual({ ok: false, reason: 'nothing_to_do' })
	})
	it('the write fails, the read-back is missing, the read-back still holds a confirmed message, the read-back lost a message that should stay, or a non-chat field changed: the ORIGINAL is put back in memory and in storage, never a lost copy', async () => {
		for (const [name, o, reason] of [
			['persist false', { persistOk: false }, 'persist_failed'],
			['persist throws', { persistThrows: true }, 'exception'],
			['readback missing', { readBack: 'missing' as const }, 'readback_missing'],
			['readback unstripped', { readBack: 'unstripped' as const }, 'readback_mismatch'],
			['readback lost more', { readBack: 'lostmore' as const }, 'readback_mismatch'],
			['fingerprint', { readBack: 'fingerprint' as const }, 'fingerprint_mismatch'],
		] as const) {
			const r = rig(o)
			const res = await cleanRecordBodies(r.deps)
			expect(`${name}:${res.ok ? 'ok' : res.reason}`).toBe(`${name}:${reason}`)
			expect(r.getLive()).toBe(r.original) // memory has the original
			expect(JSON.stringify(r.getStored())).toContain('BODY-A1') // and so does storage
			expect(r.calls[r.calls.length - 1]).toBe('persist') // the original was written back last
		}
	})
	it('the original profile objects are never mutated', async () => {
		const r = rig()
		const before = JSON.stringify(r.original)
		await cleanRecordBodies(r.deps)
		expect(JSON.stringify(r.original)).toBe(before)
	})
	it('the library is asked per conversation with the sendIds of that conversation only', async () => {
		const r = rig()
		await cleanRecordBodies(r.deps)
		expect(r.calls.filter((c) => c.startsWith('has:'))).toEqual(['has:001:a1,a2', 'has:002:b1'])
	})
})
