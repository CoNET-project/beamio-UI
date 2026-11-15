/**
 * `walletEoaAddress` : the public EOA derived from the stored native key, for the local home. It
 * goes over the window channel only (never the chat channel). The answer is `{type: "ack", reqId, ok: true, result: {eoa}}`. Any other
 * answer is a refusal, and no address is taken from it.
 */
import { ethers } from 'ethers'
import { nextReqId } from './nativeChatRouteRegister'
import { SHELL_RECORD_REPLY_TIMEOUT_MS, sendWindowOnlyCommand } from './shellRecordTransport'

export const WALLET_EOA_ADDRESS_COMMAND = 'walletEoaAddress'

export type WalletEoaAddressAnswer = { kind: 'address'; eoa: string } | { kind: 'refused'; code: string }

export async function readWalletEoaAddress(): Promise<WalletEoaAddressAnswer> {
	const reqId = nextReqId()
	const answer = await sendWindowOnlyCommand({ type: WALLET_EOA_ADDRESS_COMMAND, reqId }, SHELL_RECORD_REPLY_TIMEOUT_MS)
	if (answer.kind !== 'payload') return { kind: 'refused', code: answer.kind }
	const p = answer.payload as { type?: unknown; ok?: unknown; error?: unknown; result?: { eoa?: unknown } }
	const eoa = p.result?.eoa
	if (p.type === 'ack' && p.ok === true && typeof eoa === 'string' && ethers.isAddress(eoa)) {
		return { kind: 'address', eoa: eoa.toLowerCase() }
	}
	return { kind: 'refused', code: typeof p.error === 'string' ? p.error : 'bad_answer' }
}
