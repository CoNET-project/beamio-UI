/**
 * Local home on a G1 wallet : the entry rests on `notReadyReason` = `g1_uninitialized`, the walletEoaAddress
 * client goes over the window channel only, and the identity-only init follows the node-list rules .
 * SYNTHETIC values only.
 */
import { judgeLocalOnly } from './accountJudgement'
import { readWalletEoaAddress, WALLET_EOA_ADDRESS_COMMAND } from './walletEoaAddress'

jest.mock('./shellRecordTransport', () => ({
	SHELL_RECORD_REPLY_TIMEOUT_MS: 10_000,
	sendWindowOnlyCommand: jest.fn(),
}))
jest.mock('./nativeChatRouteRegister', () => ({ nextReqId: () => 7 }))
import { sendWindowOnlyCommand } from './shellRecordTransport'

const EOA = '0x' + '5'.repeat(40)

describe('local mode: the entry decision', () => {
	it('a readable G1 wallet (g1_uninitialized, walletState not_ready) enters the local home', () => {
		expect(judgeLocalOnly({ walletStatus: 'not_ready', notReadyReason: 'g1_uninitialized', walletState: 'not_ready' })).toBe('enter_local')
	})
	it('an unreadable wallet keeps the gate (never a basis for entry)', () => {
		expect(judgeLocalOnly({ walletStatus: 'not_ready', notReadyReason: 'unreadable', walletState: 'not_ready' })).toBe('keep_gate')
	})
	it('no notReadyReason (an older native build) keeps the gate: fail-closed', () => {
		expect(judgeLocalOnly({ walletStatus: 'not_ready', walletState: 'not_ready' })).toBe('keep_gate')
	})
	it('a walletState that contradicts the G1 answer keeps the gate', () => {
		expect(judgeLocalOnly({ walletStatus: 'not_ready', notReadyReason: 'g1_uninitialized', walletState: 'present' })).toBe('keep_gate')
		expect(judgeLocalOnly({ walletStatus: 'not_ready', notReadyReason: 'g1_uninitialized', walletState: 'not_reported' })).toBe('keep_gate')
	})
	it('a G0 (no_key) answer never enters the local home', () => {
		expect(judgeLocalOnly({ walletStatus: 'no_key', notReadyReason: 'g1_uninitialized', walletState: 'not_ready' })).toBe('keep_gate')
	})
})

describe('walletEoaAddress: the window channel only', () => {
	beforeEach(() => {
		jest.clearAllMocks()
	})

	it('a reply with the public EOA is taken, in lower case, and the command is sent with its reqId', async () => {
		;(sendWindowOnlyCommand as jest.Mock).mockResolvedValue({
			kind: 'payload',
			payload: { type: 'ack', reqId: 7, ok: true, result: { eoa: EOA.toUpperCase().replace('0X', '0x') } },
		})
		const r = await readWalletEoaAddress()
		expect(r).toEqual({ kind: 'address', eoa: EOA })
		expect((sendWindowOnlyCommand as jest.Mock).mock.calls[0][0]).toEqual({ type: WALLET_EOA_ADDRESS_COMMAND, reqId: 7 })
	})

	it('a refusal yields no address', async () => {
		;(sendWindowOnlyCommand as jest.Mock).mockResolvedValue({ kind: 'payload', payload: { type: 'ack', reqId: 7, ok: false, error: 'unavailable' } })
		expect(await readWalletEoaAddress()).toEqual({ kind: 'refused', code: 'unavailable' })
	})

	it('no window channel (not_supported) yields no address and nothing is guessed', async () => {
		;(sendWindowOnlyCommand as jest.Mock).mockResolvedValue({ kind: 'not_supported' })
		expect(await readWalletEoaAddress()).toEqual({ kind: 'refused', code: 'not_supported' })
	})

	it('a malformed address is refused', async () => {
		;(sendWindowOnlyCommand as jest.Mock).mockResolvedValue({ kind: 'payload', payload: { type: 'ack', ok: true, result: { eoa: 'not-an-address' } } })
		expect((await readWalletEoaAddress()).kind).toBe('refused')
	})
})
