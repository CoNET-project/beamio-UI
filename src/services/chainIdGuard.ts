/**
 * the first-contact chain trust (chainPgpTrust.ts) takes the chain id of a record from what the RPC itself
 * reports (`eth_chainId`), not from a constant of the build. A record is read only after the RPC has said it is on the expected chain (224422); a chain that is another one, or a
 * chain id that cannot be read, leaves the contact unavailable (the caller answers network_error: held, nothing is sent).
 *
 * The answer may be kept for the session, with two hard limits: it belongs to ONE endpoint (a different endpoint is a new question), and it is dropped at once when any read
 * fails (an old answer is never reused across endpoints or after a failure). Only an answer that matched is kept; a mismatch or a failure is asked again next time.
 */
export type ChainIdCheck =
	| { ok: true; chainId: number }
	| { ok: false; reason: 'chain_id_unavailable' | 'chain_id_mismatch'; chainId?: number }

export type ChainIdGuard = {
	check: () => Promise<ChainIdCheck>
	/** A read through this endpoint failed (the contract call, or the chain id itself): the kept answer is dropped. */
	noteReadFailure: () => void
	/** Drops the kept answer (an endpoint change does this by itself; this is for tests and for an explicit reset). */
	invalidate: () => void
}

const toNumber = (raw: unknown): number | null => {
	if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? raw : null
	if (typeof raw === 'bigint') return raw >= 0n && raw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : null
	if (typeof raw !== 'string') return null
	const t = raw.trim()
	if (/^0x[0-9a-fA-F]+$/.test(t)) {
		const n = Number.parseInt(t, 16)
		return Number.isSafeInteger(n) ? n : null
	}
	if (/^\d+$/.test(t)) {
		const n = Number(t)
		return Number.isSafeInteger(n) ? n : null
	}
	return null
}

export function createChainIdGuard(opts: { expected: number; endpoint: () => string; read: () => Promise<unknown> }): ChainIdGuard {
	let kept: { endpoint: string; chainId: number } | null = null
	const invalidate = (): void => {
		kept = null
	}
	return {
		invalidate,
		noteReadFailure: invalidate,
		check: async () => {
			const endpoint = String(opts.endpoint() ?? '')
			if (kept && kept.endpoint !== endpoint) kept = null
			if (kept) return { ok: true, chainId: kept.chainId }
			let chainId: number | null = null
			try {
				chainId = toNumber(await opts.read())
			} catch {
				chainId = null
			}
			// the endpoint may have changed while the read was running: that answer is not kept for the new one
			if (chainId === null) {
				invalidate()
				return { ok: false, reason: 'chain_id_unavailable' }
			}
			if (chainId !== opts.expected) {
				invalidate()
				return { ok: false, reason: 'chain_id_mismatch', chainId }
			}
			if (String(opts.endpoint() ?? '') === endpoint) kept = { endpoint, chainId }
			return { ok: true, chainId }
		},
	}
}
