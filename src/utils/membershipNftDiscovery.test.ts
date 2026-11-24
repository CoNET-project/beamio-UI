/**
 * @jest-environment node
 */
/** The orphan membership probe is one multicall, and a probe with no result is not repeated for a while. SYNTHETIC addresses. */
import { ethers } from 'ethers'
import {
	probeHeldTokenIds,
	orphanProbeKey,
	orphanProbeSkipped,
	orphanProbeNote,
	resetOrphanProbeForTest,
	ORPHAN_PROBE_NEGATIVE_TTL_MS,
	ORPHAN_PROBE_FAILURE_TTL_MS,
} from './membershipNftDiscovery'

jest.mock('@/config/chainAddresses', () => ({ CONET_MULTICALL3: '0x' + '55'.repeat(20) }), { virtual: true })
jest.mock('@/utils/constants', () => ({ conetDepinProvider: {} }), { virtual: true })

const CARD = '0x' + 'c1'.repeat(20)
const EOA = '0x' + '11'.repeat(20)
const AA = '0x' + '22'.repeat(20)
const u256 = (n: bigint) => ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [n])

beforeEach(() => resetOrphanProbeForTest())

describe('probeHeldTokenIds', () => {
	it('sends ONE multicall for every (holder, tokenId) and returns the held pairs', async () => {
		const ids = [100n, 101n, 102n]
		const multicall = jest.fn(async (calls: Array<{ callData: string }>) =>
			calls.map((_c, i) => ({ success: true, returnData: u256(i === 4 ? 1n : 0n) })),
		)
		const out = await probeHeldTokenIds(CARD, [EOA, AA], ids, multicall as never)
		expect(multicall).toHaveBeenCalledTimes(1)
		expect(multicall.mock.calls[0][0]).toHaveLength(6)
		expect(out.ok).toBe(true)
		expect(out.held).toEqual([{ holder: AA, tokenId: 101n }])
	})
	it('a failed answer makes the probe not ok (never a serial fallback)', async () => {
		const multicall = jest.fn(async (calls: unknown[]) => calls.map(() => ({ success: false, returnData: '0x' })))
		const out = await probeHeldTokenIds(CARD, [EOA], [100n, 101n], multicall as never)
		expect(multicall).toHaveBeenCalledTimes(1)
		expect(out.ok).toBe(false)
		expect(out.held).toEqual([])
	})
	it('no pairs: no call', async () => {
		const multicall = jest.fn()
		expect(await probeHeldTokenIds(CARD, [], [100n], multicall as never)).toEqual({ ok: true, held: [] })
		expect(multicall).not.toHaveBeenCalled()
	})
})

describe('the probe is not repeated for a while', () => {
	it('a probe that found nothing waits 10 minutes; a failed one 1 minute; a found one never waits', () => {
		const key = orphanProbeKey(CARD, [AA, EOA])
		expect(key).toBe(orphanProbeKey(CARD.toUpperCase().replace('0X', '0x'), [EOA, AA]))
		const t0 = 1_000_000
		expect(orphanProbeSkipped(key, t0)).toBe(false)
		orphanProbeNote(key, t0, 'none')
		expect(orphanProbeSkipped(key, t0 + ORPHAN_PROBE_NEGATIVE_TTL_MS - 1)).toBe(true)
		expect(orphanProbeSkipped(key, t0 + ORPHAN_PROBE_NEGATIVE_TTL_MS + 1)).toBe(false)
		orphanProbeNote(key, t0, 'failed')
		expect(orphanProbeSkipped(key, t0 + ORPHAN_PROBE_FAILURE_TTL_MS - 1)).toBe(true)
		expect(orphanProbeSkipped(key, t0 + ORPHAN_PROBE_FAILURE_TTL_MS + 1)).toBe(false)
		orphanProbeNote(key, t0, 'none')
		orphanProbeNote(key, t0, 'found')
		expect(orphanProbeSkipped(key, t0 + 1)).toBe(false)
	})
})
