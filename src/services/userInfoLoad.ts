/**
 * App init's account read with capped retries. A failed read is retried on this ladder; after the last retry the
 * init gives up, releases its claim and shows "temporarily unavailable" with a manual retry. The ladder is one read, then one retry
 * after each delay: 30 s, 2 min, 10 min (four reads at most). A stop (a vault lock or a sign-out during the wait) ends the loop.
 *
 * The read and the wait are injected, so the rules are tested without timers or the chain.
 */

/** Waits between the reads: 30 s, 2 min, 10 min. Three retries after the first read. */
export const USER_INFO_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000]

export type UserInfoReadResult<T> =
	| { status: 'ok'; info: T }
	| { status: 'no_account' }
	| { status: 'network_error'; reason: string }

export type UserInfoLoadResult<T> =
	| { status: 'ok'; info: T; reads: number }
	| { status: 'unavailable'; reason: 'no_account' | 'network_error'; reads: number }
	| { status: 'stopped'; reads: number }

export interface UserInfoLoadDeps {
	/** Waits before the next read. */
	wait: (ms: number) => Promise<void>
	/** True once the account the init is loading is no longer wanted (vault lock, sign-out). */
	stopped: () => boolean
	delays?: readonly number[]
}

export async function loadUserInfoWithBackoff<T>(
	read: () => Promise<UserInfoReadResult<T>>,
	deps: UserInfoLoadDeps,
): Promise<UserInfoLoadResult<T>> {
	const delays = deps.delays ?? USER_INFO_RETRY_DELAYS_MS
	let reads = 0
	let last: 'no_account' | 'network_error' = 'network_error'
	for (let attempt = 0; attempt <= delays.length; attempt++) {
		if (attempt > 0) {
			await deps.wait(delays[attempt - 1])
		}
		if (deps.stopped()) return { status: 'stopped', reads }
		reads += 1
		let result: UserInfoReadResult<T>
		try {
			result = await read()
		} catch {
			result = { status: 'network_error', reason: 'exception' }
		}
		if (result.status === 'ok') return { status: 'ok', info: result.info, reads }
		last = result.status === 'no_account' ? 'no_account' : 'network_error'
	}
	return { status: 'unavailable', reason: last, reads }
}
