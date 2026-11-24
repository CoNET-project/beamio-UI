/**
 * Discover membership NFTs held as ERC-1155 balances but missing from
 * `_userOwnedNfts` / getOwnership inventory (orphaned membership ledger).
 *
 * Mirror of x402sdk `membershipNftDiscovery.ts` (no DB probe — subprojects independent).
 */
import { ethers } from 'ethers'
import { multicallAggregate3ConetMain, decodeMulticallUint256, type ConetMulticallCall, type ConetMulticallResult } from '@/utils/conetMulticall3'
import {
	DISCOVER_ISSUED_NFT_START_ID,
	DISCOVER_MEMBERSHIP_NFT_MIN_ID,
	isDiscoverMembershipNftTokenId,
} from '@/utils/discoverMembershipFee'

export type OwnershipNftRow = {
	tokenId: bigint
	attribute: bigint
	tierIndexOrMax: bigint
	expiry: bigint
	isExpired: boolean
}

const OWNERSHIP_ABI = [
	'function balanceOf(address account, uint256 id) view returns (uint256)',
	'function nftAttributes(uint256 tokenId) view returns (uint256 attr)',
	'function nftExpiresAt(uint256 tokenId) view returns (uint256)',
	'function expiresAt(uint256 tokenId) view returns (uint256)',
	'function nftTierIndexOrMax(uint256 tokenId) view returns (uint256)',
	'function activeMembershipId(address user) view returns (uint256)',
	'function totalMembershipIssued() view returns (uint256)',
] as const

const MEMBERSHIP_BALANCE_PROBE_SPAN = 64n
const MEMBERSHIP_BALANCE_PROBE_HARD_CAP = 256n

/**
 * The orphan probe used to send one balanceOf eth_call per (holder, tokenId): 64 to 256 ids per holder, two holders, every card without a membership,
 * every My Brands feed run. The CoNET provider does not batch (batchMaxCount:1), so that was hundreds of POSTs a minute per card
 * (measured on a phone: 128 or 256 balanceOf calls per card per minute, 5 cards). Now: one Multicall3 call per probe, and a probe that found nothing is
 * not repeated for 10 minutes (an orphan membership is rare, and a purchase refreshes the inventory through the normal path).
 */
export const ORPHAN_PROBE_NEGATIVE_TTL_MS = 10 * 60 * 1000
/** a probe that could not run (no multicall, a failed call) is retried after this, so a broken RPC is not hammered either */
export const ORPHAN_PROBE_FAILURE_TTL_MS = 60 * 1000
const orphanProbeSkipUntil = new Map<string, number>()
export const orphanProbeKey = (cardAddress: string, holders: string[]): string =>
	`${cardAddress.toLowerCase()}|${holders.map((h) => h.toLowerCase()).sort().join(',')}`
export const orphanProbeSkipped = (key: string, nowMs: number): boolean => (orphanProbeSkipUntil.get(key) ?? 0) > nowMs
export function orphanProbeNote(key: string, nowMs: number, outcome: 'none' | 'failed' | 'found'): void {
	if (outcome === 'found') orphanProbeSkipUntil.delete(key)
	else orphanProbeSkipUntil.set(key, nowMs + (outcome === 'none' ? ORPHAN_PROBE_NEGATIVE_TTL_MS : ORPHAN_PROBE_FAILURE_TTL_MS))
	if (orphanProbeSkipUntil.size > 200) orphanProbeSkipUntil.delete(orphanProbeSkipUntil.keys().next().value as string)
}
export function resetOrphanProbeForTest(): void {
	orphanProbeSkipUntil.clear()
}

/** The (holder, tokenId) pairs with a balance above zero, from ONE multicall. `ok` is false when the probe could not run or any answer failed. */
export async function probeHeldTokenIds(
	cardAddress: string,
	holders: string[],
	tokenIds: bigint[],
	multicall: (calls: ConetMulticallCall[]) => Promise<ConetMulticallResult[]> = (c) => multicallAggregate3ConetMain(c),
): Promise<{ ok: boolean; held: Array<{ holder: string; tokenId: bigint }> }> {
	const iface = new ethers.Interface(OWNERSHIP_ABI)
	const pairs = holders.flatMap((holder) => tokenIds.map((tokenId) => ({ holder, tokenId })))
	if (!pairs.length) return { ok: true, held: [] }
	const results = await multicall(pairs.map((p) => ({ target: cardAddress, allowFailure: true, callData: iface.encodeFunctionData('balanceOf', [p.holder, p.tokenId]) })))
	let ok = results.length === pairs.length
	const held: Array<{ holder: string; tokenId: bigint }> = []
	pairs.forEach((p, i) => {
		const r = results[i]
		if (!r || !r.success) {
			ok = false
			return
		}
		const v = decodeMulticallUint256(r.returnData)
		if (v === null) ok = false
		else if (v > 0n) held.push(p)
	})
	return { ok, held }
}

function nftKey(n: OwnershipNftRow): string {
	return String(n.tokenId)
}

async function readExpiry(card: ethers.Contract, tokenId: bigint): Promise<bigint> {
	try {
		return BigInt(await card.nftExpiresAt(tokenId))
	} catch {
		try {
			return BigInt(await card.expiresAt(tokenId))
		} catch {
			return 0n
		}
	}
}

async function readTierIndexOrMax(card: ethers.Contract, tokenId: bigint): Promise<bigint> {
	try {
		return BigInt(await card.nftTierIndexOrMax(tokenId))
	} catch {
		return ethers.MaxUint256
	}
}

async function readMembershipNftRowIfHeld(
	card: ethers.Contract,
	holder: string,
	tokenId: bigint,
	nowSec: bigint,
): Promise<OwnershipNftRow | null> {
	if (!isDiscoverMembershipNftTokenId(tokenId)) return null
	try {
		const bal = await card.balanceOf(holder, tokenId)
		if (BigInt(bal ?? 0) <= 0n) return null
		const [attrRaw, expiry, tierIndexOrMax] = await Promise.all([
			card.nftAttributes(tokenId).catch(() => 0n),
			readExpiry(card, tokenId),
			readTierIndexOrMax(card, tokenId),
		])
		const attribute = BigInt(attrRaw ?? 0)
		const isExpired = expiry > 0n && expiry <= nowSec
		if (isExpired) return null
		return { tokenId, attribute, tierIndexOrMax, expiry, isExpired: false }
	} catch {
		return null
	}
}

async function collectMembershipTokenIdCandidates(
	card: ethers.Contract,
	holders: string[],
): Promise<bigint[]> {
	const ids = new Set<string>()
	const add = (raw: unknown) => {
		try {
			const tid = typeof raw === 'bigint' ? raw : BigInt(String(raw ?? '').trim() || '0')
			if (isDiscoverMembershipNftTokenId(tid)) ids.add(tid.toString())
		} catch {
			/* ignore */
		}
	}

	// Always probe #100 — common orphan after bootstrap / dirty inventory.
	ids.add(DISCOVER_MEMBERSHIP_NFT_MIN_ID.toString())

	for (const holder of holders) {
		try {
			add(await card.activeMembershipId(holder))
		} catch {
			/* ignore — dirty ids in [1,99] are filtered by isDiscoverMembershipNftTokenId */
		}
	}

	try {
		const total = BigInt(await card.totalMembershipIssued().catch(() => 0n))
		const span =
			total > 0n && total < MEMBERSHIP_BALANCE_PROBE_HARD_CAP
				? total
				: MEMBERSHIP_BALANCE_PROBE_SPAN
		const end = DISCOVER_MEMBERSHIP_NFT_MIN_ID + span
		for (
			let tid = DISCOVER_MEMBERSHIP_NFT_MIN_ID;
			tid < end && tid < DISCOVER_ISSUED_NFT_START_ID;
			tid++
		) {
			ids.add(tid.toString())
		}
	} catch {
		for (let i = 0n; i < MEMBERSHIP_BALANCE_PROBE_SPAN; i++) {
			ids.add((DISCOVER_MEMBERSHIP_NFT_MIN_ID + i).toString())
		}
	}

	return Array.from(ids)
		.map((s) => BigInt(s))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * When inventory-backed ownership has no membership NFT, probe balanceOf for
 * membership tokenIds on each holder (EOA and/or AA).
 */
export async function discoverOrphanMembershipNfts(input: {
	provider: ethers.Provider
	cardAddress: string
	holders: string[]
	existingTokenIds?: ReadonlyArray<string | number | bigint>
}): Promise<OwnershipNftRow[]> {
	const holders = Array.from(
		new Set(
			input.holders
				.map((h) => {
					try {
						return ethers.getAddress(String(h || '').trim())
					} catch {
						return ''
					}
				})
				.filter(Boolean),
		),
	)
	if (!holders.length) return []

	const hasMembershipInInventory = (input.existingTokenIds ?? []).some((id) =>
		isDiscoverMembershipNftTokenId(id),
	)
	if (hasMembershipInInventory) return []

	const probeKey = orphanProbeKey(input.cardAddress, holders)
	// a probe that found nothing (or could not run) a moment ago is not repeated (see ORPHAN_PROBE_NEGATIVE_TTL_MS)
	if (orphanProbeSkipped(probeKey, Date.now())) return []
	const card = new ethers.Contract(input.cardAddress, OWNERSHIP_ABI, input.provider)
	const nowSec = BigInt(Math.floor(Date.now() / 1000))
	const candidates = await collectMembershipTokenIdCandidates(card, holders)
	const found = new Map<string, OwnershipNftRow>()

	// one multicall for all balances; only a held (holder, tokenId) gets the detail reads
	const probe = await probeHeldTokenIds(input.cardAddress, holders, candidates)
	await Promise.all(
		probe.held.map(async ({ holder, tokenId }) => {
			const row = await readMembershipNftRowIfHeld(card, holder, tokenId, nowSec)
			if (!row) return
			const k = nftKey(row)
			if (!found.has(k)) found.set(k, row)
		}),
	)
	orphanProbeNote(probeKey, Date.now(), found.size > 0 ? 'found' : probe.ok ? 'none' : 'failed')

	return Array.from(found.values())
}
