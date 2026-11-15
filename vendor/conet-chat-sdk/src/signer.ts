/**
 * Account signing for the chat SDK. The account private key never enters the SDK and never enters the worker. Every
 * signature the worker needs is asked of the host (`signRequest` / `signResponse`); the host signs and returns only the
 * signature. In a browser the host signs with the page's account signer; a native shell answers from its own key store.
 *
 * Decision (2026-11-13, PWA worker task): the worker holds no account key. The history master secret is still
 * derived in the worker from a host signature (/ scope), and PGP decryption still runs in the worker.
 */
import { ethers } from 'ethers'
import type { TypedDataDomain, TypedDataField } from 'ethers'

/** One signature the worker needs. Typed data carries no key material; `value` may contain bigint. */
export type AccountSignRequest =
	| { kind: 'eip191'; message: string }
	| {
			kind: 'eip712'
			domain: TypedDataDomain
			types: Record<string, TypedDataField[]>
			value: Record<string, unknown>
	  }

/** Host callback. Resolves to a 0x-prefixed signature, or rejects (the worker then fails that one operation). */
export type AccountSignFn = (request: AccountSignRequest) => Promise<string>

/** What the SDK code uses: the address and the two signing calls (structurally compatible with `ethers.Wallet`). */
export interface AccountSigning {
	readonly address: string
	signMessage(message: string): Promise<string>
	signTypedData(
		domain: TypedDataDomain,
		types: Record<string, TypedDataField[]>,
		value: Record<string, unknown>,
	): Promise<string>
}

/** Wraps a host callback as the signing object the SDK code uses. The address is checksummed. */
export function createAccountSigning(address: string, sign: AccountSignFn): AccountSigning {
	const checksummed = ethers.getAddress(address.trim().toLowerCase())
	return {
		address: checksummed,
		signMessage: (message: string) => sign({ kind: 'eip191', message }),
		signTypedData: (domain, types, value) => sign({ kind: 'eip712', domain, types, value }),
	}
}
