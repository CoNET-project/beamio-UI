/**
 * Mailbox choice for the automatic first open (worker side, step (a) of the first-open plan).
 *
 * A first open with no record has no chain mailbox. If the page already knows the account's current mailbox, it is used. Otherwise a
 * random node is chosen among the nodes AddressPGP has recorded (`nodeKeyExists(keccak256(routeKeyID))`): an unrecorded node answers
 * `not_my_route` for every account (2026-11-02), so it is never used. A failed check picks nothing; the caller waits and retries.
 *
 * `pickRecordedMailbox` is the same rule as src/services/chatOwnRoutePlan.ts in the page (a copy; a parity test keeps them equal).
 * Pure: the chain check is passed in.
 */
import { ethers } from 'ethers'

export type FirstOpenMailbox = { routeKeyID: string; routeArmor: string }

export type RecordedMailboxPick<T> =
	| { status: 'ok'; node: T; skipped: string[] }
	| { status: 'none'; skipped: string[] }
	| { status: 'error'; reason: string; skipped: string[] }

/** Random-order candidates; the first recorded one wins. A failed or timed-out check returns an error, never a pick. */
export async function pickRecordedMailbox<T>(deps: {
	candidates: readonly T[]
	routeKeyID: (node: T) => string
	isRecorded: (routeKeyID: string) => Promise<boolean>
	maxChecks?: number
	timeoutMs?: number
}): Promise<RecordedMailboxPick<T>> {
	const maxChecks = deps.maxChecks ?? 8
	const timeoutMs = deps.timeoutMs ?? 8_000
	const skipped: string[] = []
	const seen = new Set<string>()
	for (const node of deps.candidates) {
		if (seen.size >= maxChecks) break
		const id = String(deps.routeKeyID(node) || '').trim()
		if (!id || seen.has(id.toUpperCase())) continue
		seen.add(id.toUpperCase())
		let recorded: boolean
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			recorded = await Promise.race([
				deps.isRecorded(id),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error('nodeKeyExists timeout')), timeoutMs)
				}),
			])
		} catch (ex) {
			return { status: 'error', reason: String((ex as Error)?.message || ex).slice(0, 120), skipped }
		} finally {
			clearTimeout(timer)
		}
		if (recorded) return { status: 'ok', node, skipped }
		skipped.push(id)
	}
	return { status: 'none', skipped }
}

export type FirstOpenMailboxPick = { status: 'ok'; mailbox: FirstOpenMailbox; source: 'current' | 'recorded-node' } | { status: 'none' } | { status: 'error'; reason: string }

/**
 * The mailbox a first open registers on. `current` (the page's known mailbox, verified by the page) wins; else a recorded node is chosen.
 * Candidates need `domain` (the route key ID) and `armoredPublicKey` (the route armor).
 */
export async function chooseFirstOpenMailbox(deps: {
	current: FirstOpenMailbox | null
	nodes: ReadonlyArray<{ domain?: string; armoredPublicKey?: string }>
	isRecorded: (routeKeyID: string) => Promise<boolean>
	maxChecks?: number
	timeoutMs?: number
}): Promise<FirstOpenMailboxPick> {
	const current = deps.current
	if (current && current.routeKeyID.trim() && current.routeArmor.trim()) {
		return { status: 'ok', mailbox: { routeKeyID: current.routeKeyID.trim(), routeArmor: current.routeArmor.trim() }, source: 'current' }
	}
	const candidates = deps.nodes.filter((n) => String(n.domain || '').trim() && String(n.armoredPublicKey || '').trim())
	const pick = await pickRecordedMailbox({
		candidates,
		routeKeyID: (n) => String(n.domain).trim(),
		isRecorded: deps.isRecorded,
		maxChecks: deps.maxChecks,
		timeoutMs: deps.timeoutMs,
	})
	if (pick.status === 'error') return { status: 'error', reason: pick.reason }
	if (pick.status === 'none') return { status: 'none' }
	return {
		status: 'ok',
		mailbox: { routeKeyID: String(pick.node.domain).trim(), routeArmor: String(pick.node.armoredPublicKey).trim() },
		source: 'recorded-node',
	}
}

/** AddressPGP `nodeKeyExists`, read on the chain RPC (no `from`). Throws on RPC error. */
export const NODE_KEY_EXISTS_ABI = ['function nodeKeyExists(bytes32) view returns (bool)'] as const

export function makeNodeKeyExistsCheck(provider: ethers.Provider, pgpManagerAddress: string): (routeKeyID: string) => Promise<boolean> {
	const contract = new ethers.Contract(pgpManagerAddress, NODE_KEY_EXISTS_ABI as unknown as string[], provider)
	return async (routeKeyID: string) => Boolean(await contract.nodeKeyExists(ethers.id(routeKeyID)))
}
