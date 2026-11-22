/**
 * CT-14: the unlocked walletStatus accountKey (`eoa:workspace`) is compared with the EOA this page expects. Both sides are
 * lower-cased before the comparison. A missing side, or a side that is not an address, is unknown (never equal, never different).
 */
export type AccountMatch = 'equal' | 'different' | 'unknown'

const ADDRESS_RE = /^0x[0-9a-f]{40}$/

export function accountKeyMatch(expectedEoa: string | null | undefined, accountKey: string | null | undefined): AccountMatch {
	if (!expectedEoa || !accountKey) return 'unknown'
	const expected = expectedEoa.trim().toLowerCase()
	const eoa = (accountKey.split(':')[0] ?? '').trim().toLowerCase()
	if (!ADDRESS_RE.test(expected) || !ADDRESS_RE.test(eoa)) return 'unknown'
	return expected === eoa ? 'equal' : 'different'
}

/**
 * PD-A/B/C: after a page-derived create, the outcome is judged from the
 * walletStatus answer. A: unlocked with an accountKey whose EOA equals the expected EOA (established). B: unlocked with an accountKey
 * for another EOA (not this create's success; another account exists). C: anything else (locked without an accountKey, unknown, timed out,
 * or unlocked without an accountKey): unfinished, wait and retry. A native-generated create does not use these categories.
 *
 * Reachability: in the delivered paths this
 * classifier is NOT REACHABLE. It has no call site. Where a non-shell path later obtains a native result, it must be wired here and tested
 * (CT-14 wiring, PD-A/B/C) before that path ships.
 */
export type PageDerivedCategory = 'A' | 'B' | 'C'
export type PageDerivedWalletStatus =
	| { status: 'unlocked'; accountKey?: string | null }
	| { status: 'locked' | 'unknown' | 'timeout' }

export function classifyPageDerived(expectedEoa: string | null | undefined, walletStatus: PageDerivedWalletStatus | null | undefined): PageDerivedCategory {
	if (!walletStatus || walletStatus.status !== 'unlocked') return 'C'
	const match = accountKeyMatch(expectedEoa, walletStatus.accountKey ?? undefined)
	if (match === 'equal') return 'A'
	if (match === 'different') return 'B'
	return 'C'
}
