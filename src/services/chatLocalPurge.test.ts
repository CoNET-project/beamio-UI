/**
 * purge tests on a SYNTHETIC profile (rule 5: no real user data, no real keys).
 * The wallet-like values below are fixed strings used only to check that they survive byte for byte.
 */
import {
	CHAT_BODIES_PURGED_KEY,
	canonicalJson,
	countChatMessages,
	isChatBodiesPurgedFor,
	markChatBodiesPurged,
	migrationExtraFromProfiles,
	nonChatFingerprint,
	profileEoaOf,
	profilesForPersist,
	stripChatBodiesFromProfiles,
} from './chatLocalPurge'
import { runMigrationCore, type MigrationDeps } from './chatLocalMigrationCore'

const EOA = '0x1111111111111111111111111111111111111111'
const PEER = '0x2222222222222222222222222222222222222222'

function syntheticProfiles(): unknown[] {
	return [
		{
			keyID: EOA,
			privateKeyArmor: 'SYNTHETIC-ARMOR-NOT-A-KEY',
			mnemonicArmor: 'SYNTHETIC-MNEMONIC-NOT-A-SEED',
			title: 'synthetic profile',
			cardRedeems: [{ id: 7, amount: 3 }],
			phoneCalls: [{ callId: 'c1', status: 'ended' }],
			chats: [
				{
					address: PEER,
					beamio: { username: 'bob' },
					messages: [
						{ id: 'm1', sendId: '1767225600000-aaaa', from: 'me', text: 'hello FIXTURE-1', createdAt: 1767225600000, status: 'sent' },
						{ id: 'tmp_2', from: 'them', text: 'reply FIXTURE-2', createdAt: 1767225601000, status: 'sending' },
					],
					pin: false,
					hide: false,
					chatData: { publicArmored: 'SYNTHETIC-PGP-PUBLIC', routersArmoreds: '', online: false, routePgpKeyID: '' },
					unreadCount: 0,
					tag: 'grey',
					muted: false,
					preview: 'hello FIXTURE-1',
					lastMessage: 'reply FIXTURE-2',
				},
			],
		},
	]
}

describe('chat body strip', () => {
	it('removes message bodies and previews, keeps every other chat field', () => {
		const before = syntheticProfiles()
		const after = stripChatBodiesFromProfiles(before) as Array<{ chats: Array<Record<string, unknown>> }>
		expect(after[0].chats[0].messages).toEqual([])
		expect('preview' in after[0].chats[0]).toBe(false)
		expect('lastMessage' in after[0].chats[0]).toBe(false)
		expect(after[0].chats[0].address).toBe(PEER)
		expect(after[0].chats[0].chatData).toEqual({ publicArmored: 'SYNTHETIC-PGP-PUBLIC', routersArmoreds: '', online: false, routePgpKeyID: '' })
	})

	it('does not mutate the original objects (rollback relies on this)', () => {
		const before = syntheticProfiles()
		const snapshot = JSON.stringify(before)
		stripChatBodiesFromProfiles(before)
		expect(JSON.stringify(before)).toBe(snapshot)
	})

	it('non-chat fields are identical before and after: equal fingerprints', () => {
		const before = syntheticProfiles()
		const after = stripChatBodiesFromProfiles(before)
		expect(nonChatFingerprint(after)).toBe(nonChatFingerprint(before))
		expect(countChatMessages(before)).toBe(2)
		expect(countChatMessages(after)).toBe(0)
	})

	it('the fingerprint changes when a non-chat field changes (the check can fail)', () => {
		const before = syntheticProfiles()
		const tampered = syntheticProfiles() as Array<Record<string, unknown>>
		tampered[0].privateKeyArmor = 'SYNTHETIC-ARMOR-CHANGED'
		expect(nonChatFingerprint(tampered)).not.toBe(nonChatFingerprint(before))
	})

	it('canonical JSON is key-order independent', () => {
		expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
	})
})

describe('purged flag and persist', () => {
	beforeEach(() => globalThis.localStorage?.clear())

	it('persists unchanged until the account is purged, then strips', () => {
		const p = syntheticProfiles()
		expect(profilesForPersist(p)).toBe(p)
		expect(profileEoaOf(p)).toBe(EOA)
		markChatBodiesPurged(EOA)
		expect(isChatBodiesPurgedFor(EOA)).toBe(true)
		expect(isChatBodiesPurgedFor('0x9999999999999999999999999999999999999999')).toBe(false)
		expect(countChatMessages(profilesForPersist(p))).toBe(0)
		expect(globalThis.localStorage.getItem(CHAT_BODIES_PURGED_KEY)).toBe(EOA)
	})
})

describe('migration extras (input)', () => {
	it('builds one row per message with the mirror JSON body, direction and pending flag', () => {
		const rows = migrationExtraFromProfiles(syntheticProfiles())
		expect(rows).toHaveLength(2)
		expect(rows[0]).toMatchObject({ peer: PEER, dir: 'out', ts: 1767225600000, sendId: '1767225600000-aaaa', pending: false })
		expect(rows[1]).toMatchObject({ dir: 'in', ts: 1767225601000, pending: true })
		expect(JSON.parse(rows[0].body).text).toBe('hello FIXTURE-1')
	})

	it('skips messages without a finite timestamp', () => {
		const p = syntheticProfiles() as Array<{ chats: Array<{ messages: unknown[] }> }>
		p[0].chats[0].messages.push({ id: 'x', from: 'me', text: 'no time' })
		expect(migrationExtraFromProfiles(p)).toHaveLength(2)
	})
})

function fakeDeps(initial: unknown[], overrides: Partial<MigrationDeps> = {}) {
	let live: unknown[] = initial
	const stored: { value: unknown[] | null } = { value: initial }
	const calls: string[] = []
	const deps: MigrationDeps = {
		workerState: async () => 'switched',
		workerSwitch: async () => {
			calls.push('switch')
			return true
		},
		workerPurge: async () => {
			calls.push('purge')
			return 2
		},
		liveProfiles: () => live,
		setLiveProfiles: (p) => {
			live = p
			calls.push('setLive')
		},
		persistProfiles: async () => {
			calls.push('persist')
			stored.value = live
			return true
		},
		readStoredProfiles: async () => stored.value,
		markPurged: () => calls.push('markPurged'),
		...overrides,
	}
	return { deps, calls, getLive: () => live, stored }
}

describe('runChatLocal (orchestration)', () => {
	it('success: strips in memory and storage, purges plain keys, marks the account', async () => {
		const original = syntheticProfiles()
		const { deps, calls, getLive, stored } = fakeDeps(original)
		const res = await runMigrationCore(deps)
		expect(res).toEqual({ ok: true, purged: 2, alreadyPurged: false })
		expect(countChatMessages(getLive())).toBe(0)
		expect(countChatMessages(stored.value)).toBe(0)
		expect(calls).toEqual(['setLive', 'persist', 'purge', 'markPurged'])
	})

	it('state complete: switches first, then purges', async () => {
		const { deps, calls } = fakeDeps(syntheticProfiles(), { workerState: async () => 'complete' })
		const res = await runMigrationCore(deps)
		expect(res.ok).toBe(true)
		expect(calls[0]).toBe('switch')
	})

	it('refuses before : nothing is touched', async () => {
		const original = syntheticProfiles()
		const { deps, calls, getLive } = fakeDeps(original, { workerState: async () => 'running' })
		const res = await runMigrationCore(deps)
		expect(res).toEqual({ ok: false, reason: 'precondition_state_running' })
		expect(calls).toEqual([])
		expect(getLive()).toBe(original)
	})

	it('already purged: no work', async () => {
		const { deps, calls } = fakeDeps(syntheticProfiles(), { workerState: async () => 'purged' })
		expect(await runMigrationCore(deps)).toEqual({ ok: true, purged: 0, alreadyPurged: true })
		expect(calls).toEqual([])
	})

	it('persist fails: rolls back to the original objects and does not purge', async () => {
		const original = syntheticProfiles()
		const { deps, calls, getLive } = fakeDeps(original, { persistProfiles: async () => false })
		const res = await runMigrationCore(deps)
		expect(res.ok).toBe(false)
		expect(getLive()).toBe(original)
		expect(calls).not.toContain('purge')
		expect(calls).not.toContain('markPurged')
	})

	it('read-back fingerprint mismatch: rolls back and does not purge', async () => {
		const original = syntheticProfiles()
		const { deps, calls, getLive, stored } = fakeDeps(original, {
			readStoredProfiles: async () => {
				const bad = stripChatBodiesFromProfiles(syntheticProfiles()) as Array<Record<string, unknown>>
				bad[0].privateKeyArmor = 'SYNTHETIC-ARMOR-DRIFT'
				return bad
			},
		})
		const res = await runMigrationCore(deps)
		expect(res).toMatchObject({ ok: false, reason: 'fingerprint_mismatch' })
		expect(getLive()).toBe(original)
		expect(calls).not.toContain('purge')
		void stored
	})

	it('stored copy still holds bodies: rolls back and does not purge', async () => {
		const original = syntheticProfiles()
		const { deps, calls, getLive } = fakeDeps(original, { readStoredProfiles: async () => syntheticProfiles() })
		const res = await runMigrationCore(deps)
		expect(res).toMatchObject({ ok: false, reason: 'bodies_remain' })
		expect(getLive()).toBe(original)
		expect(calls).not.toContain('purge')
	})

	it('worker purge fails after the profile was stripped: profile is restored, account not marked', async () => {
		const original = syntheticProfiles()
		const { deps, calls, getLive } = fakeDeps(original, {
			workerPurge: async () => {
				throw new Error('kv delete failed')
			},
		})
		const res = await runMigrationCore(deps)
		expect(res).toEqual({ ok: false, reason: 'kv delete failed' })
		expect(getLive()).toBe(original)
		expect(countChatMessages(getLive())).toBe(2)
		expect(calls).not.toContain('markPurged')
	})
})
