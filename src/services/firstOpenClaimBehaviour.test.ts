/**
 * @jest-environment node
 */
/**
 * R81 item 3: the claimBUnits gate, behaviour. Simulated start of the browser first-open path: the automatic claim (the only path to
 * POST /api/claimBUnits) is not called, so the count is 0. Other entries are unchanged. SYNTHETIC values only.
 */
import { autoBUnitClaimGated } from './firstOpenClaimGateNow'

jest.mock('openpgp', () => ({ generateKey: async () => ({}), readKey: async () => ({}) }))

const ARMOR = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nS\n-----END PGP PUBLIC KEY BLOCK-----'
const PK = '0x' + '11'.repeat(32)
const CLAIMANT = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'

function start(over: { lookup?: 'no_record' | 'record' | 'network_error'; shell?: boolean; profile?: unknown } = {}) {
	const claim = jest.fn(async () => 'posted')
	const lookupStatus = over.lookup ?? 'no_record'
	const lookup = async () =>
		lookupStatus === 'no_record' ? { status: 'no_record' as const } : lookupStatus === 'record' ? { status: 'ok' as const, publicArmored: ARMOR, routersArmoreds: ARMOR } : { status: 'network_error' as const }
	const result = autoBUnitClaimGated({
		privateKeyArmor: PK,
		profile: over.profile ?? { keyID: CLAIMANT },
		shell: over.shell ?? false,
		lookup,
		claimant: CLAIMANT,
		claim,
	})
	return { result, claim }
}

describe('claimBUnits on the browser first-open path (R81 item 3)', () => {
	it('simulated browser start with no PGP record: the automatic claim is not sent (0 calls of the POST path)', async () => {
		const { result, claim } = start()
		expect(await result).toBe('skipped_first_open')
		expect(claim).toHaveBeenCalledTimes(0)
	})

	it('the same start after a restart with a pending key: still the first-open path, the claim is not sent', async () => {
		const { result, claim } = start({ profile: { keyID: CLAIMANT, pendingChatFirstOpen: { keyID: 'K1', privateKey: 'P', publicKey: 'U' } } })
		expect(await result).toBe('skipped_first_open')
		expect(claim).toHaveBeenCalledTimes(0)
	})

	it('other entries are unchanged: a wallet with a record on the chain sends the automatic claim once', async () => {
		const { result, claim } = start({ lookup: 'record' })
		expect(await result).toBe('claimed')
		expect(claim).toHaveBeenCalledTimes(1)
		expect(claim).toHaveBeenCalledWith(PK, CLAIMANT)
	})

	it('a failed read is unknown: the claim is kept (not the first-open path)', async () => {
		const { result, claim } = start({ lookup: 'network_error' })
		expect(await result).toBe('claimed')
		expect(claim).toHaveBeenCalledTimes(1)
	})

	it('a shell is never the browser first-open path: the claim is kept', async () => {
		const { result, claim } = start({ shell: true })
		expect(await result).toBe('claimed')
		expect(claim).toHaveBeenCalledTimes(1)
	})
})

/**
 * R81 §2.3 (R87 item 2): the first-open path sends no claim POST. The claim here posts to the same path the app's claim posts to; the network
 * spy is what the test observes. A mutation that lets the claim run on the first-open path makes the spy see the POST.
 */
describe('the first-open path sends no POST /api/claimBUnits (R87 item 2)', () => {
	it('a browser with no record: the network sees no claim request', async () => {
		const realFetch = globalThis.fetch
		const spy = jest.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }))
		globalThis.fetch = spy as unknown as typeof fetch
		try {
			const claim = jest.fn(async () => {
				await fetch('https://claim.test/api/claimBUnits', { method: 'POST' })
				return 'posted'
			})
			const r = await autoBUnitClaimGated({
				privateKeyArmor: PK,
				profile: { keyID: CLAIMANT },
				shell: false,
				lookup: async () => ({ status: 'no_record' as const }),
				claimant: CLAIMANT,
				claim,
			})
			expect(r).toBe('skipped_first_open')
			expect(spy).not.toHaveBeenCalled()
		} finally {
			globalThis.fetch = realFetch
		}
	})

	it('a wallet with a record on the chain sends the claim request once (the gate is not too wide)', async () => {
		const realFetch = globalThis.fetch
		const spy = jest.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }))
		globalThis.fetch = spy as unknown as typeof fetch
		try {
			const claim = jest.fn(async () => {
				await fetch('https://claim.test/api/claimBUnits', { method: 'POST' })
				return 'posted'
			})
			const r = await autoBUnitClaimGated({
				privateKeyArmor: PK,
				profile: { keyID: CLAIMANT },
				shell: false,
				lookup: async () => ({ status: 'ok' as const, publicArmored: ARMOR, routersArmoreds: ARMOR }),
				claimant: CLAIMANT,
				claim,
			})
			expect(r).toBe('claimed')
			expect(spy).toHaveBeenCalledTimes(1)
		} finally {
			globalThis.fetch = realFetch
		}
	})
})
