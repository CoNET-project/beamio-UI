/**
 * @jest-environment node
 */
// the runtime chain id check and its session cache. SYNTHETIC endpoints.
import { createChainIdGuard } from './chainIdGuard'

const make = (answers: Array<unknown | Error>, endpoint = { url: 'https://rpc-a.invalid' }) => {
	let i = 0
	const read = jest.fn(async () => {
		const a = answers[Math.min(i++, answers.length - 1)]
		if (a instanceof Error) throw a
		return a
	})
	const guard = createChainIdGuard({ expected: 224422, endpoint: () => endpoint.url, read })
	return { guard, read, endpoint }
}

describe('chain id guard', () => {
	it('the expected chain (hex, decimal string, number) is ok and reports the ACTUAL chain id', async () => {
		for (const raw of ['0x36ca6', '224422', 224422, BigInt(224422)]) {
			expect(await make([raw]).guard.check()).toEqual({ ok: true, chainId: 224422 })
		}
	})
	it('another chain is a mismatch (and is not kept)', async () => {
		const { guard, read } = make(['0x1', '0x1'])
		expect(await guard.check()).toEqual({ ok: false, reason: 'chain_id_mismatch', chainId: 1 })
		expect(await guard.check()).toEqual({ ok: false, reason: 'chain_id_mismatch', chainId: 1 })
		expect(read).toHaveBeenCalledTimes(2)
	})
	it('a read that fails, or an answer that is not a chain id, is unavailable', async () => {
		expect(await make([new Error('rpc down')]).guard.check()).toEqual({ ok: false, reason: 'chain_id_unavailable' })
		for (const bad of [null, undefined, '', 'abc', '0x', '-1', 1.5, {}, '0xzz']) {
			expect(await make([bad]).guard.check()).toEqual({ ok: false, reason: 'chain_id_unavailable' })
		}
	})
	it('a matching answer is kept for the session: one read for many checks', async () => {
		const { guard, read } = make(['0x36ca6'])
		await guard.check()
		await guard.check()
		await guard.check()
		expect(read).toHaveBeenCalledTimes(1)
	})
	it('the kept answer is dropped when the ENDPOINT changes: the new endpoint is asked again', async () => {
		const { guard, read, endpoint } = make(['0x36ca6', '0x1'])
		expect((await guard.check()).ok).toBe(true)
		expect(read).toHaveBeenCalledTimes(1)
		endpoint.url = 'https://rpc-b.invalid'
		// the old (good) answer must not be reused for another endpoint: it is asked again and this one is on another chain
		expect(await guard.check()).toEqual({ ok: false, reason: 'chain_id_mismatch', chainId: 1 })
		expect(read).toHaveBeenCalledTimes(2)
		// and going back to the first endpoint asks again too (nothing was kept for it)
		endpoint.url = 'https://rpc-a.invalid'
		await guard.check()
		expect(read).toHaveBeenCalledTimes(3)
	})
	it('the kept answer is dropped after a read FAILURE (noteReadFailure): the next check asks again', async () => {
		const { guard, read } = make(['0x36ca6', '0x1'])
		expect((await guard.check()).ok).toBe(true)
		guard.noteReadFailure()
		expect(await guard.check()).toEqual({ ok: false, reason: 'chain_id_mismatch', chainId: 1 })
		expect(read).toHaveBeenCalledTimes(2)
	})
	it('a failed chain id read drops what was kept and an old good answer is never used afterwards', async () => {
		const { guard, read } = make(['0x36ca6', new Error('x'), '0x36ca6'])
		expect((await guard.check()).ok).toBe(true)
		guard.invalidate()
		expect((await guard.check()).ok).toBe(false) // the read fails
		expect((await guard.check()).ok).toBe(true) // asked again, answers again
		expect(read).toHaveBeenCalledTimes(3)
	})
	it('an answer that arrives after the endpoint changed is not kept for the new endpoint', async () => {
		const endpoint = { url: 'https://rpc-a.invalid' }
		let release: (v: unknown) => void = () => undefined
		let calls = 0
		const read = jest.fn(() => (++calls === 1 ? new Promise<unknown>((resolve) => { release = resolve }) : Promise.resolve('0x36ca6')))
		const guard = createChainIdGuard({ expected: 224422, endpoint: () => endpoint.url, read })
		const pending = guard.check()
		endpoint.url = 'https://rpc-b.invalid'
		release('0x36ca6')
		expect((await pending).ok).toBe(true)
		await guard.check()
		expect(read).toHaveBeenCalledTimes(2)
	})
})
