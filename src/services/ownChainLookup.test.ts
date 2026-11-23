/**
 * R76-2: the own-chain read uses the three-state lookup. A valid record is the own record; a valid empty answer is "no record"; a network
 * error is a failed read (status error) and never reaches the register branch. SYNTHETIC values only.
 */
import { ownChainRecordFromLookup } from './ownChainLookup'
import { planOwnChatRoute, readOwnChainState } from './chatOwnRoutePlan'
import { readFileSync } from 'fs'
import { join } from 'path'

const probe = async () => ({ state: 'missing' as const, armored: '' })

describe('own-chain three-state lookup (R76-2)', () => {
	it('ok: the record carries the user key, the route, and the armor', () => {
		expect(
			ownChainRecordFromLookup({ status: 'ok', publicArmored: 'PUB', routersArmoreds: 'ROUTE', userPgpKeyID: 'UID', routePgpKeyID: 'RID' }),
		).toEqual({ userKeyID: 'UID', routeKeyID: 'RID', routeArmor: 'ROUTE', publicArmored: 'PUB' })
	})

	it('no_record (a valid empty answer) is null', () => {
		expect(ownChainRecordFromLookup({ status: 'no_record' })).toBeNull()
	})

	it('network_error throws: it is never an empty record', () => {
		expect(() => ownChainRecordFromLookup({ status: 'network_error', reason: 'timeout' })).toThrow('own record read failed')
	})

	it('a network error reads as status error, and the plan never registers on it (it waits or keeps the current mailbox)', async () => {
		const own = await readOwnChainState({
			first: null,
			searchKey: async () => ownChainRecordFromLookup({ status: 'network_error', reason: 'stale node' }),
			probeBlob: probe,
		})
		expect(own.read.status).toBe('error')
		const plan = planOwnChatRoute({ read: own.read, localKeyID: '', current: null, currentArmor: '' } as never)
		expect(plan.action).not.toBe('register')
	})

	it('a valid empty answer reads as empty, the only case that may plan a register', async () => {
		const own = await readOwnChainState({
			first: null,
			searchKey: async () => ownChainRecordFromLookup({ status: 'no_record' }),
			probeBlob: probe,
		})
		expect(own.read.status).toBe('empty')
	})

	it('chat.ts maps its own-chain searchKey through the three-state lookup (source check)', () => {
		const chat = readFileSync(join(__dirname, 'chat.ts'), 'utf8')
		expect(chat).toMatch(/return ownChainRecordFromLookup\(await lookupRecipientRecord\(address\)\)/)
	})
})
