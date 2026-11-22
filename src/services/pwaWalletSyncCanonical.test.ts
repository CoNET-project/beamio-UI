/**
 * @jest-environment node
 */
/**
 * The sync sends the canonical phrase (the SDK rule) and only when it derives to the request EOA.
 * Cases are generated at run time by mnemonicVectorsLoader.ts (official BIP-39 phrases and their transforms; the sets are pinned
 * in mnemonicEoaCrossImpl.test.ts). Node environment: derivation runs here (not in jsdom). SYNTHETIC values only where labelled.
 */
import { canonicalPhrase } from './mnemonicCanonical'
import { loadVectors, type VectorCase } from './mnemonicVectorsLoader'

const mockSend = jest.fn()
const mockLog = jest.fn()
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: (...a: unknown[]) => mockLog(...a) }))
jest.mock('./shellRecordTransport', () => ({
	sendShellWalletSyncCommand: (...a: unknown[]) => mockSend(...a),
	shellRecordTransportKind: () => 'window',
}))

import { sendPwaWalletSync } from './pwaWalletSyncTransport'

type Vector = VectorCase
const CASES_23 = loadVectors('sdk23').cases
const loadCasesSynthetic = () => loadVectors('synthetic100').cases
const DOC = { cases: CASES_23 }
const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const ACK = { kind: 'payload', payload: { type: 'ack', ok: true, result: { sync: 'updated' } } }

// cases: SDK accepts, the wire did not send before this change
const DIFF_W = ['inner-multi-space', 'inner-tab-newline', 'nbsp-between', 'ideographic-space', 'uppercase', 'mixed-case', 'fullwidth-nfkd', 'tab-inside', 'newline-inside']

beforeEach(() => {
	mockSend.mockReset()
	mockSend.mockResolvedValue(ACK)
})

describe('canonicalPhrase follows the SDK rule on every vector', () => {
	it.each(DOC.cases.filter((c) => c.expect_behaviour === 'accept').map((c) => [c.id, c] as const))('%s', (_id, c) => {
		expect(canonicalPhrase(c.input)).toBe(c.expected_canonical)
	})
})

describe('the sync sends the canonical phrase and the derived EOA, and nothing the SDK rejects', () => {
	it.each(DOC.cases.filter((c) => c.expect_behaviour === 'accept').map((c) => [c.id, c] as const))('accepted: %s is sent once, canonical, with its EOA', async (_id, c) => {
		const out = await sendPwaWalletSync('pwaWalletSync', 7, c.input, c.expected_eoa as string)
		expect(out.code).toBe('ok')
		expect(mockSend).toHaveBeenCalledTimes(1)
		const cmd = mockSend.mock.calls[0][0] as { phrase: string; eoa: string }
		expect(cmd.phrase).toBe(c.expected_canonical)
		expect(cmd.eoa).toBe(c.expected_eoa)
	})

	it.each(DOC.cases.filter((c) => c.expect_behaviour === 'reject').map((c) => [c.id, c] as const))('rejected: %s is never sent (format: bad_request; derivation failed: no_answer, retryable)', async (_id, c) => {
		const out = await sendPwaWalletSync('pwaWalletSync', 7, c.input, EOA)
		const formatRefused = !/^[a-z]+( [a-z]+)*$/.test(canonicalPhrase(c.input))
		expect(out.code).toBe(formatRefused ? 'bad_request' : 'no_answer')
		expect(mockSend).not.toHaveBeenCalled()
	})

	it('the nine spellings are exactly the accepted cases the raw phrase (before this change) could not send', () => {
		const rawRefused = DOC.cases
			.filter((c) => c.expect_behaviour === 'accept' && !/^[a-z]+( [a-z]+)*$/.test(c.input.trim()))
			.map((c) => c.id)
			.sort()
		expect(rawRefused).toEqual([...DIFF_W].sort())
	})

	it('derivation failure (checksum) is no_answer, nothing sent, and only the reason name is logged', async () => {
		mockLog.mockClear()
		const bad = DOC.cases.find((c) => c.id === 'bad-checksum') as Vector
		const out = await sendPwaWalletSync('pwaWalletSync', 7, bad.input, EOA)
		expect(out.code).toBe('no_answer')
		expect(mockSend).not.toHaveBeenCalled()
		expect(mockLog).toHaveBeenCalledTimes(1)
		const logged = String(mockLog.mock.calls[0][1])
		expect(logged).toContain('canonical_derive_failed')
		for (const word of bad.input.split(' ')) expect(logged).not.toContain(word)
		expect(logged).not.toMatch(/0x[0-9a-fA-F]{40}/)
	})

	it('derivation that throws is also no_answer (a thrown error is not a wrong address)', async () => {
		jest.resetModules()
		jest.doMock('./shellLegacyIdbInit', () => ({
			...jest.requireActual('./shellLegacyIdbInit'),
			mnemonicEoa: () => {
				throw new Error('derive threw (test)')
			},
		}))
		const transport = require('./pwaWalletSyncTransport') as typeof import('./pwaWalletSyncTransport')
		mockSend.mockClear()
		const out = await transport.sendPwaWalletSync('pwaWalletSync', 7, DOC.cases[0].input, EOA)
		expect(out.code).toBe('no_answer')
		expect(mockSend).not.toHaveBeenCalled()
	})

	it('derivation gives a different address: bad_request, nothing sent, no derivation-failure log', async () => {
		mockLog.mockClear()
		const out = await sendPwaWalletSync('pwaWalletSync', 7, DOC.cases[0].input, '0x1111111111111111111111111111111111111111')
		expect(out.code).toBe('bad_request')
		expect(mockSend).not.toHaveBeenCalled()
		expect(mockLog.mock.calls.some((c) => String(c[1]).includes('canonical_derive_failed'))).toBe(false)
	})

	it('a valid phrase with the wrong EOA is refused before sending', async () => {
		const out = await sendPwaWalletSync('pwaWalletSync', 7, DOC.cases[0].input, '0x1111111111111111111111111111111111111111')
		expect(out.code).toBe('bad_request')
		expect(mockSend).not.toHaveBeenCalled()
	})
})

describe('100 synthetic cases: canonical form, emission and EOA through the real sync function', () => {
	it('every case: canonicalPhrase equals expected_canonical', () => {
		const CASES_SYNTHETIC = loadCasesSynthetic()
		const bad = CASES_SYNTHETIC.filter((c) => canonicalPhrase(c.input) !== c.expected_canonical).map((c) => c.id)
		expect(bad).toEqual([])
	})
	it('every case: the sync emits exactly when pwa_sync_emits says so, with the expected canonical phrase and EOA', async () => {
		const bad: string[] = []
		for (const c of loadCasesSynthetic()) {
			mockSend.mockClear()
			const out = await sendPwaWalletSync('pwaWalletSync', 9, c.input, c.expected_eoa as string)
			const emitted = mockSend.mock.calls.length === 1
			if (emitted !== c.pwa_sync_emits) {
				bad.push(c.id + ':emit')
				continue
			}
			if (emitted) {
				const cmd = mockSend.mock.calls[0][0] as { phrase: string; eoa: string }
				if (cmd.phrase !== c.expected_canonical || cmd.eoa !== c.expected_eoa || out.code !== 'ok') bad.push(c.id + ':payload')
			}
		}
		expect(bad).toEqual([])
	})
})
