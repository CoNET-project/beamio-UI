/**
 * The signed registration data of `AddressPGP.addPublicPGPBySig` (GAS-1 plan B). The wallet signs the EIP-712 typed data; the Cluster
 * verifies it; the Master submits it with operator-paid gas, and the contract verifies the wallet signature again (signer must equal `to`).
 *
 * Layout (src/mainnet/AddressPGP.sol, typehash AddPublicPGP): domain name "AddressPGP", version "1", the CoNET chain id, the AddressPGP address.
 * The struct holds keccak256 hashes of the texts, the route hash (0 when no route is preset), the on-chain nonce pgpNonces[to] and the deadline.
 * The texts hashed here are the texts submitted: the armors are trimmed first (no trailing whitespace is ever hashed or submitted).
 *
 * Reserved (not in the contract): a PGP possession signature (double verification). It is carried as `pgpPossessionSignature`
 * and is never part of the on-chain struct. The wire format is provisional until interface r2.5.20 v4 is fixed; this module is the only place
 * that builds the registration data, so an alignment changes this file only.
 */
import { ethers } from 'ethers'

export const ADDRESS_PGP_DOMAIN_NAME = 'AddressPGP'
export const ADDRESS_PGP_DOMAIN_VERSION = '1'
export const ADD_PUBLIC_PGP_TYPES: Record<string, Array<{ name: string; type: string }>> = {
	AddPublicPGP: [
		{ name: 'to', type: 'address' },
		{ name: 'pgpKeyIDHash', type: 'bytes32' },
		{ name: 'publicKeyArmoredHash', type: 'bytes32' },
		{ name: 'encrypKeyArmoredHash', type: 'bytes32' },
		{ name: 'routePgpKeyIDHash', type: 'bytes32' },
		{ name: 'nonce', type: 'uint256' },
		{ name: 'deadline', type: 'uint256' },
	],
}

export type AddPublicPGPInput = {
	chainId: number
	verifyingContract: string
	to: string
	pgpKeyID: string
	publicKeyArmored: string
	encrypKeyArmored: string
	/** '' when no route is preset */
	routePgpKeyID: string
	/** pgpNonces[to] read from the chain at signing time */
	nonce: bigint | number
	deadline: number
	/** Reserved: the PGP possession signature. Never on-chain. */
	pgpPossessionSignature?: string
}

const utf8Hash = (s: string): string => ethers.keccak256(ethers.toUtf8Bytes(s))

/** The texts as they are submitted: trimmed, so the hash and the submitted string are the same. */
export function normalizeAddPublicPGPText(s: string): string {
	return String(s ?? '').trim()
}

/** The EIP-712 domain, types and message for the struct. Pure. */
export function buildAddPublicPGPTypedData(input: AddPublicPGPInput) {
	const pgpKeyID = normalizeAddPublicPGPText(input.pgpKeyID)
	const publicKeyArmored = normalizeAddPublicPGPText(input.publicKeyArmored)
	const encrypKeyArmored = normalizeAddPublicPGPText(input.encrypKeyArmored)
	const routePgpKeyID = normalizeAddPublicPGPText(input.routePgpKeyID)
	const domain = {
		name: ADDRESS_PGP_DOMAIN_NAME,
		version: ADDRESS_PGP_DOMAIN_VERSION,
		chainId: input.chainId,
		verifyingContract: ethers.getAddress(input.verifyingContract),
	}
	const message = {
		to: ethers.getAddress(input.to),
		pgpKeyIDHash: utf8Hash(pgpKeyID),
		publicKeyArmoredHash: utf8Hash(publicKeyArmored),
		encrypKeyArmoredHash: utf8Hash(encrypKeyArmored),
		routePgpKeyIDHash: routePgpKeyID ? utf8Hash(routePgpKeyID) : ethers.ZeroHash,
		nonce: BigInt(input.nonce),
		deadline: BigInt(input.deadline),
	}
	const submitted = { pgpKeyID, publicKeyArmored, encrypKeyArmored, routePgpKeyID }
	return { domain, types: ADD_PUBLIC_PGP_TYPES, message, submitted, pgpPossessionSignature: input.pgpPossessionSignature ?? null }
}

/** The wallet's EIP-712 signature over the struct (the signer must be `to`). */
export async function signAddPublicPGPBySig(wallet: ethers.Wallet | ethers.HDNodeWallet, input: AddPublicPGPInput): Promise<string> {
	const td = buildAddPublicPGPTypedData(input)
	if (wallet.address.toLowerCase() !== td.message.to.toLowerCase()) throw new Error('signer_is_not_to')
	return wallet.signTypedData(td.domain, td.types, td.message)
}
