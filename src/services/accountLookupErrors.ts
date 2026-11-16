/**
 * getAccount failure classification. Only the AccountNotFound() revert is a valid "no record" answer; every other
 * failure (timeout, network, another revert) is a lookup failure and must never be read as "no account".
 */
import { ethers } from 'ethers'

/** The only valid "no record" answer of getAccount: the registry reverts with AccountNotFound(). Any other failure is a lookup failure. */
const ACCOUNT_NOT_FOUND_SELECTOR = ethers.id('AccountNotFound()').slice(0, 10)

export const isAccountNotFoundError = (ex: unknown): boolean => {
	const e = ex as { revert?: { name?: string }; data?: unknown; error?: { data?: unknown } } | null
	if (!e || typeof e !== 'object') return false
	if (e.revert?.name === 'AccountNotFound') return true
	const data = e.data ?? e.error?.data
	return typeof data === 'string' && data.toLowerCase().startsWith(ACCOUNT_NOT_FOUND_SELECTOR.toLowerCase())
}
