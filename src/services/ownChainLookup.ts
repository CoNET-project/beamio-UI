/**
 * The own-chain read's searchKey mapping. A valid answer with a key and a route is
 * the own record; a valid empty answer is "no record"; a failed, timed-out or incomplete answer is a network error. A network error is never
 * an empty record: it becomes a failed own-chain read (readOwnChainState: status error), which never reaches the register branch.
 */
import type { RecipientLookup } from './recipientRecord'
import type { OwnChainRecord } from './chatOwnRoutePlan'

/** Returns the own record, or null for a valid empty answer. Throws for a network error (the caller records it as an error read). */
export function ownChainRecordFromLookup(lookup: RecipientLookup): OwnChainRecord | null {
	if (lookup.status === 'ok') {
		return {
			userKeyID: lookup.userPgpKeyID || '',
			routeKeyID: lookup.routePgpKeyID || '',
			routeArmor: lookup.routersArmoreds,
			publicArmored: lookup.publicArmored,
		}
	}
	if (lookup.status === 'no_record') return null
	throw new Error(`own record read failed (${lookup.reason})`)
}
