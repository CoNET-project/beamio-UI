/**
 * The App-side claim gate (the read part of firstOpenClaimGate.ts). The lookup is passed in by the caller (App imports the chat module; this
 * module does not, so the chat-page import guard stays exact). A failed read is unknown: the claim is kept.
 */
import { ethers } from 'ethers'
import { skipAutoBUnitClaimForFirstOpen, type ClaimGateLookup } from './firstOpenClaimGate'

/**
 * The App-side gate: reads AddressPGP for the wallet (three states) and asks the pure rule. A failed read is unknown: the claim is kept.
 * The profile's chat key and pending copy come from the profile object; the pending copy is read from its own field.
 */
export async function firstOpenClaimSkipNow(args: { privateKeyArmor: string; profile: unknown; shell: boolean; lookup: (address: string) => Promise<ClaimGateLookup> }): Promise<boolean> {
	if (args.shell) return false
	const address = new ethers.Wallet(args.privateKeyArmor).address
	const lookup = await args.lookup(address).catch((): ClaimGateLookup => ({ status: 'network_error' }))
	const prof = (args.profile ?? {}) as { chatManager?: { pgpKey?: { privateKey?: string; publicKey?: string } } ; pendingChatFirstOpen?: { keyID?: unknown; privateKey?: unknown; publicKey?: unknown } | null }
	const key = prof.chatManager?.pgpKey
	const pending = prof.pendingChatFirstOpen
	return skipAutoBUnitClaimForFirstOpen({
		shell: false,
		lookup,
		localChatKeyComplete: Boolean(key?.privateKey && key?.publicKey),
		pendingPresent: Boolean(pending && pending.keyID && pending.privateKey && pending.publicKey),
	})
}

/**
 * The automatic claim, behind the first-open gate (R81 item 3). The claim function is the only path to POST /api/claimBUnits; on the
 * first-open path it is not called (0 POSTs). Other entries call it as before. Injected, so the behaviour is tested without the network.
 */
export async function autoBUnitClaimGated(args: {
	privateKeyArmor: string
	profile: unknown
	shell: boolean
	lookup: (address: string) => Promise<ClaimGateLookup>
	claimant: string
	claim: (privateKeyArmor: string, claimant: string) => Promise<unknown>
}): Promise<'skipped_first_open' | 'claimed'> {
	if (await firstOpenClaimSkipNow({ privateKeyArmor: args.privateKeyArmor, profile: args.profile, shell: args.shell, lookup: args.lookup })) {
		return 'skipped_first_open'
	}
	await args.claim(args.privateKeyArmor, args.claimant)
	return 'claimed'
}
