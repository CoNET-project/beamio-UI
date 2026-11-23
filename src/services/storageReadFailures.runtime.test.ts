/**
 * @jest-environment node
 */
/**
 * run-time simulation of the browser storage failures on the real storage read, with the PouchDB store replaced by a
 * fake. Open failure, read error and a read that never answers. Each must be a non-absent answer. SYNTHETIC; no network, no chain.
 */
const mockPouch = jest.fn()
jest.mock('pouchdb', () => ({ __esModule: true, default: (...args: unknown[]) => mockPouch(...args) }))
// argon2idAsync must not run in these tests (the PBKDF2 stand-in is removed). The bridge module cannot load in jest (import.meta),
// so it stays mocked, but a call fails closed. A test that needs the v3 KDF injects it with setMnemonicKdfForTest.
jest.mock('@/services/argon2WorkerBridge', () => ({
	argon2idAsync: () => {
		throw new Error('argon2idAsync must not run in this test: inject the v3 KDF with setMnemonicKdfForTest')
	},
}))
jest.mock('@/services/beamioTagWorkerBridge', () => ({ searchBeamioTagRemote: jest.fn() }))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const beamio = require('./beamio') as typeof import('./beamio')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const judgement = require('./accountJudgement') as typeof import('./accountJudgement')

describe('storage read failures on the real read path', () => {
	beforeEach(() => {
		mockPouch.mockReset()
	})

	it('open failure: the store cannot be opened, so the read reports unavailable, and the account is undetermined', async () => {
		mockPouch.mockImplementation(() => {
			throw new Error('IndexedDB open failed (simulated)')
		})
		const result = await beamio.checkStorageWithStatus({ probe: true })
		expect(result.status).toBe('unavailable')
		expect(judgement.judgeBrowser(judgement.idbSignalOf(result as any))).toEqual({ account: 'undetermined', action: 'retry' })
	})

	it('read error: the store opens but the read fails (not a missing document), so the read reports unavailable', async () => {
		mockPouch.mockImplementation(() => ({
			get: async () => {
				throw Object.assign(new Error('read failed (simulated)'), { status: 500, name: 'unknown_error' })
			},
		}))
		const result = await beamio.checkStorageWithStatus({ probe: true })
		expect(result.status).toBe('unavailable')
		expect(judgement.judgeBrowser(judgement.idbSignalOf(result as any))).toEqual({ account: 'undetermined', action: 'retry' })
	})

	it('a read that never answers: the timed read gives no record, so it is never a confirmed empty store', async () => {
		mockPouch.mockImplementation(() => ({ get: () => new Promise(() => undefined) }))
		const timed = await beamio.checkStorageWithTimeout(20)
		expect(timed).toBeNull()
	})

	it('a missing init document is the only confirmed empty store (the control case)', async () => {
		mockPouch.mockImplementation(() => ({
			get: async () => {
				throw Object.assign(new Error('missing'), { status: 404, name: 'not_found' })
			},
		}))
		const result = await beamio.checkStorageWithStatus({ probe: true })
		expect(result.status).toBe('empty')
	})
})
