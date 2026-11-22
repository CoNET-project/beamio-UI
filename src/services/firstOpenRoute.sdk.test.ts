/**
 * @jest-environment node
 */
/**
 * The first-open mailbox choice in the SDK (vendor/conet-chat-sdk/src/firstOpenRoute.ts): a verified current mailbox wins; otherwise a
 * random recorded node, with a failed check picking nothing. Parity with the page rule (chatOwnRoutePlan.ts pickRecordedMailbox).
 * SYNTHETIC values only.
 */
import { chooseFirstOpenMailbox, pickRecordedMailbox as sdkPick } from '../../vendor/conet-chat-sdk/dist/firstOpenRoute.js'
import { pickRecordedMailbox as pagePick } from './chatOwnRoutePlan'

const nodes = [
	{ domain: 'n1.synth', armoredPublicKey: 'ARM-1' },
	{ domain: 'n2.synth', armoredPublicKey: 'ARM-2' },
	{ domain: 'n3.synth', armoredPublicKey: 'ARM-3' },
]
const recordedOnly = (...ids: string[]) => async (id: string) => ids.includes(id)

describe('first-open mailbox choice (SDK)', () => {
	it('a verified current mailbox wins: no node is checked', async () => {
		let checks = 0
		const r = await chooseFirstOpenMailbox({
			current: { routeKeyID: 'cur.synth', routeArmor: 'ARM-CUR' },
			nodes,
			isRecorded: async () => (checks++, true),
		})
		expect(r).toEqual({ status: 'ok', mailbox: { routeKeyID: 'cur.synth', routeArmor: 'ARM-CUR' }, source: 'current' })
		expect(checks).toBe(0)
	})

	it('no current mailbox: the first recorded node is used, an unrecorded node is skipped', async () => {
		const r = await chooseFirstOpenMailbox({ current: null, nodes, isRecorded: recordedOnly('n2.synth', 'n3.synth') })
		expect(r.status).toBe('ok')
		if (r.status === 'ok') {
			expect(r.source).toBe('recorded-node')
			expect(['n2.synth', 'n3.synth']).toContain(r.mailbox.routeKeyID)
			expect(r.mailbox.routeArmor).toBe(r.mailbox.routeKeyID === 'n2.synth' ? 'ARM-2' : 'ARM-3')
		}
	})

	it('no recorded node: none, nothing is picked', async () => {
		expect(await chooseFirstOpenMailbox({ current: null, nodes, isRecorded: recordedOnly() })).toEqual({ status: 'none' })
	})

	it('a failed check is an error, never a pick (the caller waits and retries)', async () => {
		const r = await chooseFirstOpenMailbox({
			current: null,
			nodes,
			isRecorded: async () => {
				throw new Error('rpc down')
			},
		})
		expect(r.status).toBe('error')
	})

	it('a blank current mailbox is not a current mailbox', async () => {
		const r = await chooseFirstOpenMailbox({ current: { routeKeyID: ' ', routeArmor: 'ARM' }, nodes, isRecorded: recordedOnly('n1.synth') })
		expect(r.status === 'ok' && r.source).toBe('recorded-node')
	})

	it('at most eight checks, duplicates checked once', async () => {
		const many = Array.from({ length: 12 }, (_, i) => ({ domain: `m${i}.synth`, armoredPublicKey: `A${i}` }))
		let checks = 0
		const r = await sdkPick({ candidates: [...many, many[0]], routeKeyID: (n) => n.domain, isRecorded: async () => (checks++, false) })
		expect(r.status).toBe('none')
		expect(checks).toBe(8)
	})
})

describe('parity with the page rule', () => {
	const scenarios: Array<{ name: string; ids: string[]; fail?: boolean }> = [
		{ name: 'first recorded', ids: ['n2.synth'] },
		{ name: 'none recorded', ids: [] },
		{ name: 'a failed check', ids: [], fail: true },
	]
	for (const sc of scenarios) {
		it(`same answer for "${sc.name}"`, async () => {
			const isRec = async (id: string) => {
				if (sc.fail) throw new Error('rpc')
				return sc.ids.includes(id)
			}
			// the random order is removed: one candidate at a time keeps both rules deterministic
			const one = [nodes[1]]
			const a = await sdkPick({ candidates: one, routeKeyID: (n) => n.domain, isRecorded: isRec })
			const b = await pagePick({ candidates: one, routeKeyID: (n) => n.domain, isRecorded: isRec })
			expect(a.status).toBe(b.status)
		})
	}
})
