/**
 * r11 walletStatus parsing (plan §五, §七; LK-P7, key_only, phrase_only, R-29). Synthetic values only.
 */
import { parseWalletStatusResult } from './accountPresence'

const isAddr = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v)
const EOA = '0x' + '1'.repeat(40)

describe('parseWalletStatusResult (r11)', () => {
	it('key_only is kept as the not_ready reason', () => {
		expect(parseWalletStatusResult({ status: 'not_ready', notReadyReason: 'key_only' }, isAddr)).toEqual({ status: 'not_ready', notReadyReason: 'key_only' })
	})
	it('an unknown not_ready reason is normalised to unreadable (R-29), never absent', () => {
		expect(parseWalletStatusResult({ status: 'not_ready', notReadyReason: 'rollback_pending' }, isAddr)).toEqual({ status: 'not_ready', notReadyReason: 'unreadable' })
		expect(parseWalletStatusResult({ status: 'not_ready' }, isAddr)).toEqual({ status: 'not_ready', notReadyReason: 'unreadable' })
	})
	it('phrase_only with an accountKey is phrase_only with the lower-case eoa', () => {
		expect(parseWalletStatusResult({ status: 'phrase_only', accountKey: EOA + ':ws' }, isAddr)).toEqual({ status: 'phrase_only', eoa: EOA })
	})
	it('phrase_only without a valid accountKey is unknown', () => {
		expect(parseWalletStatusResult({ status: 'phrase_only' }, isAddr)).toEqual({ status: 'unknown' })
	})
	it('locked with an accountKey still parses as locked (the presence and the gate decide what it means)', () => {
		expect(parseWalletStatusResult({ status: 'locked', accountKey: EOA + ':ws' }, isAddr)).toEqual({ status: 'locked', eoa: EOA })
	})
});
