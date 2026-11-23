/**
 * Chat start in a native shell from the native public identity. The start reads the public
 * material with `identityPublic` and starts the native listen with it. It does not read the wallet key, and it does not run any
 * page-key step (own-chain reads, registration, the connection signer). The collaborators are passed in, so the order is testable.
 */
import type { NativeIdentityPublic } from './nativeIdentityPublic'
import type { PgpEvaluation, PgpRestoreOutcome } from './nativePgpRestore'
import type { PgpRestoreFailure } from './pgpRestore'
import { firstIdentityConfirmed, grantPgpCreateEligibility, revokePgpCreateEligibility } from './pgpIdentityEligibility'

export type ShellStartResult =
	| 'started'
	| 'initialised'
	| 'no_key'
	| 'not_ready'
	| 'identity_mismatch'
	| 'identity_source_missing'
	| 'pgp_not_ready'
	| 'pgp_restored'
	| 'pgp_failed'
	| 'pgp_first_identity'
	| 'pgp_identity_pending'
	| 'chat_unavailable'
	| 'identity_closed'
	| 'failed'

export interface ShellListenParams {
	ownRouteArmoredPublicKey: string
	eoaAddress: string
	pgpPublicKeyArmored: string
	nodes: nodeInfo[]
	rootSignal: AbortSignal
	onLine: (line: string) => void
	onActivity: () => void
	onLog: (level: 'info' | 'warn' | 'error', message: string) => void
}

type nodeInfo = { domain: string; armoredPublicKey?: string }

export interface ShellChatStartDeps {
	readIdentity: () => Promise<NativeIdentityPublic>
	getNodes: () => Promise<nodeInfo[]>
	setAllNodes: (nodes: nodeInfo[]) => void
	setGossip: (on: boolean) => void
	mailboxDomainsFor: (nodes: nodeInfo[], routeArmored: string) => Set<string>
	/** Healthy entries among the candidates (host probe). */
	pickEntries: (candidates: nodeInfo[]) => Promise<nodeInfo[]>
	/** Called once the listen has its entries, before it starts: the ack context uses the same mailboxes and entries. */
	onListenPlanned: (plan: { routeArmored: string; entryNodes: nodeInfo[]; mailboxDomains: Set<string> }) => void
	/** Called with the controller that owns the listen, so the caller can tear it down. */
	onController: (controller: AbortController) => void
	startListen: (p: ShellListenParams) => Promise<boolean>
	onLine: (line: string) => void
	onActivity: () => void
	log: (level: 'info' | 'warn' | 'error', message: string) => void
	/** The public EOA kept from the last ok restore or create; '' when there is none. Not an identity basis. */
	readPersistedEoa: () => string
	/** true: no identity source, show "retry later"; false: the identity is read, clear it. */
	setIdentityPending: (pending: boolean) => void
	/** true: no chain record and no backup (first identity): the page shows the entry. */
	setFirstIdentity: (value: boolean) => void
	/** G1: init with the persisted EOA only; route and PGP keys are not sent. A refusal leaves the start waiting. */
	initWithPersistedEoa?: (eoa: string, nodes: nodeInfo[]) => Promise<{ ok: true } | { ok: false; reason: string }>
	/** -6: the temporary source state is shown (true) or cleared (false). */
	setPgpTemporary?: (value: boolean) => void
	/** the reason of a listen start the native layer refused (read once after a start that did not start); null otherwise. */
	listenRefusal?: () => string | null
	/** Read-only PGP evaluation (pgpRestoreEvaluate). Run when identityPublic answers pgpReady false; never a create. */
	evaluatePgp: () => Promise<PgpEvaluation>
	/** Restores the original identity (pgpRestore). Called only after an evaluation of ok. */
	restorePgp: () => Promise<PgpRestoreOutcome>
	/** Shows the restore failure; the user's entry is the only way to generate, and the page never generates from here. */
	showPgpFailure: (code: PgpRestoreFailure) => void
	/** the unified chat-unavailable state (option A), the same screen as a missing identity capability. */
	showChatUnavailable: () => void
	/** the chat identity is pending (not a first identity, not confirmed): its own notice, not the app-update notice. */
	showIdentityPending: () => void
	/**
	 * Schedules another start. `failure`(the default) counts toward the retry limit; `continue`is a step that
	 * succeeded and goes on (a restored PGP, a completed G1 init), and it does not count.
	 */
	retry: (reason: string, kind?: 'failure' | 'continue' | 'temporary') => void
	/** the closed reason of the listen start (`clear_failed`or `unregister_refused`), read once. Null otherwise. */
	takeIdentityClosed?: () => 'clear_failed' | 'unregister_refused' | null
	/** shows the closed notice with its button. No automatic retry follows. */
	showIdentityClosed?: (reason: 'clear_failed' | 'unregister_refused') => void
}

/**
 * Runs one start. Outcomes:
 *  - no_key: G0 (the gate shows the import route; nothing to start).
 *  - not_ready: G1 (init is needed first; the public identity is G2-only, so this start waits for the next attempt).
 *  - pgp_not_ready: G2 but no PGP record yet (the PGP restore has not produced one; no retry from here).
 *  - failed: a transient failure (unreadable answer, no nodes, no entry, listen did not start); the caller may retry.
 */
/**
 * the node list is read here. A failure (or an empty list) is an explicit unavailable state: the chat shows it, and the start is
 * retried. Nothing is passed on as an empty list.
 */
async function readNodesOrUnavailable(deps: ShellChatStartDeps): Promise<nodeInfo[] | null> {
	try {
		const nodes = await deps.getNodes()
		if (nodes.length) return nodes
		deps.log('warn', 'shell chat: the node list is empty: unavailable; the start is retried')
	} catch (err) {
		deps.log('warn', `shell chat: the node list could not be read (${err instanceof Error ? err.message : String(err)}): unavailable; the start is retried`)
	}
	deps.setGossip(false)
	deps.showChatUnavailable()
	deps.retry('node list unavailable')
	return null
}

export async function startShellChatFromNativeIdentity(deps: ShellChatStartDeps): Promise<ShellStartResult> {
	const id = await deps.readIdentity()
	if (id.kind === 'no_key') {
		deps.setGossip(false)
		deps.log('info', 'shell chat: no key on this device (G0); the import route applies')
		return 'no_key'
	}
	if (id.kind === 'not_ready') {
		deps.setGossip(false)
		const eoa = deps.readPersistedEoa()
		if (!eoa) {
			//  no identity source. Nothing is guessed; the page says to retry later.
			deps.setIdentityPending(true)
			deps.log('warn', 'shell chat: key present, not initialised (G1), and no persisted public EOA; the chat waits')
			return 'identity_source_missing'
		}
		// Held: the chain does not send the G1 init until the rules; the injected initializer is absent
		// while SHELL_G1_INIT_ENABLED is false, so the start waits here and nothing is sent.
		if (!deps.initWithPersistedEoa) {
			deps.log('info', 'shell chat: key present, not initialised (G1); the G1 init is held, the start waits')
			return 'not_ready'
		}
		const nodes = await readNodesOrUnavailable(deps)
		if (!nodes) return 'failed'
		const init = await deps.initWithPersistedEoa(eoa, nodes)
		if (!init.ok) {
			deps.log('warn', `shell chat: init with the persisted EOA did not succeed (${init.reason}); the start waits`)
			return 'not_ready'
		}
		deps.log('info', 'shell chat: init with the persisted EOA succeeded (G2); the start is retried')
		deps.retry('g1 init done', 'continue')
		return 'initialised'
	}
	if (id.kind !== 'ok') {
		deps.setGossip(false)
		deps.log('warn', `shell chat: identityPublic answered ${id.kind}; the start is retried`)
		deps.retry(`identityPublic ${id.kind}`)
		return 'failed'
	}
	deps.setIdentityPending(false)
	deps.setFirstIdentity(false)
	if (!id.pgpReady || !id.pgpPublicKeyArmored || !id.ownRouteArmoredPublicKey) {
		deps.setGossip(false)
		if (confirmedAccounts.has(accountKeyOf(id))) {
			// items 2 and 4: this account was confirmed to match the backup in this process. No evaluate and no restore. The route
			// is still missing (the native identityPublic todo): the chat is unavailable, not silent, no replace prompt, no retry.
			deps.log('warn', 'shell chat: identityPublic still reads pgpReady false after already_exists; the identity is usable, the route is missing (native todo); no evaluate, no restore; the chat is unavailable')
			deps.showChatUnavailable()
			return 'chat_unavailable'
		}
		deps.log('warn', 'shell chat: pgpReady false; the state is read by pgpRestoreEvaluate (no create, no restore from this flag)')
		return evaluateMissingPgp(deps, accountKeyOf(id))
	}

	const nodes = await readNodesOrUnavailable(deps)
	if (!nodes) return 'failed'
	if (!nodes.length) {
		deps.setGossip(false)
		deps.log('warn', 'shell chat: no CoNET nodes; the start is retried')
		deps.retry('no CoNET nodes')
		return 'failed'
	}
	deps.setAllNodes(nodes)

	const route = id.ownRouteArmoredPublicKey
	const mailboxDomains = deps.mailboxDomainsFor(nodes, route)
	const candidates = nodes.filter((n) => !mailboxDomains.has(n.domain))
	const entryNodes = await deps.pickEntries(candidates.length ? candidates : nodes)
	if (!entryNodes.length) {
		deps.setGossip(false)
		deps.log('warn', 'shell chat: no healthy entry C; the start is retried')
		deps.retry('no healthy entry')
		return 'failed'
	}

	deps.onListenPlanned({ routeArmored: route, entryNodes, mailboxDomains })
	const controller = new AbortController()
	deps.onController(controller)
	deps.setGossip(true)
	const started = await deps.startListen({
		ownRouteArmoredPublicKey: route,
		eoaAddress: id.eoa,
		pgpPublicKeyArmored: id.pgpPublicKeyArmored,
		nodes,
		rootSignal: controller.signal,
		onLine: deps.onLine,
		onActivity: deps.onActivity,
		onLog: deps.log,
	})
	if (!started) {
		deps.setGossip(false)
		// the native layer closed the identity module (clear_failed, or unregister_refused after an import). The
		// start does not retry it: the closed notice takes over, with its own button.
		const closed = deps.takeIdentityClosed?.() ?? null
		if (closed) {
			deps.log('warn', `shell chat: the native layer closed the identity (${closed}); no automatic retry, the closed notice is shown`)
			deps.showIdentityClosed?.(closed)
			return 'identity_closed'
		}
		//a refusal of the account is not a failure to retry. No retry, no init loop, and no import or lock page.
		if (deps.listenRefusal?.() === 'address_mismatch') {
			deps.log('warn', 'shell chat: init refused with address_mismatch (G2); the start is not retried')
			return 'identity_mismatch'
		}
		deps.log('warn', 'shell chat: the native listen did not start; the start is retried')
		deps.retry('native listen did not start')
		return 'failed'
	}
	return 'started'
}

/**
 * `already_exists`means this account's local identity already matches the backup. The accounts
 * confirmed in this page process are kept here (by account key). For those accounts, later starts in this process send neither
 * pgpRestoreEvaluate nor pgpRestore. A process restart (a cold start) starts with an empty set, so at most one restore per cold start.
 */
const confirmedAccounts = new Set<string>()
/** For tests: a cold start (an empty confirmation set). */
export function resetShellChatStartLoopGuard(): void {
	confirmedAccounts.clear()
}
function accountKeyOf(id: { accountKey?: string; eoa?: string }): string {
	return (id.accountKey || id.eoa || '').trim().toLowerCase()
}

/**
 * pgpReady false: the state is read through the existing evaluate path. A restore runs only after an evaluation of
 * ok, and never from the flag alone. A repeat restore that the native layer refuses as already_exists stops here (no retry loop).
 */
async function evaluateMissingPgp(deps: ShellChatStartDeps, accountKey: string): Promise<ShellStartResult> {
	const ev = await deps.evaluatePgp()
	if (ev.kind === 'source_unavailable') {
		//1: a temporary state (undetermined). It is retried; it is not counted as a failure, shows no terminal
		// notice, and never starts the rebuild path (2 needs a confirmed absence).
		deps.log('info', 'shell chat: pgp source unavailable (temporary): the dedicated message is shown; retried with the usual backoff, not counted')
		deps.setPgpTemporary?.(true)
		deps.retry('pgp source unavailable', 'temporary')
		return 'failed'
	}
	deps.setPgpTemporary?.(false)
	if (ev.kind !== 'evaluated') {
		deps.log('warn', ev.kind === 'refused' ? `shell chat: pgpRestoreEvaluate refused (${ev.code}); the start waits` : 'shell chat: pgpRestoreEvaluate unanswered; the start waits')
		return 'pgp_not_ready'
	}
	if (ev.state === 'first_identity') {
		// first-identity rule: a first identity needs the legacy report ABSENT and an unregistered chain. Anything else (a field missing, unknown,
		// PRESENT, UNREADABLE, registered) is not a first identity: no create entry, and the identity waits for a restore.
		if (firstIdentityConfirmed(ev)) {
			grantPgpCreateEligibility(accountKey)
			deps.setFirstIdentity(true)
			deps.log('info', 'shell chat: legacy ABSENT and chain unregistered (first identity); the user creates it from the entry')
			return 'pgp_first_identity'
		}
		revokePgpCreateEligibility(accountKey)
		deps.setFirstIdentity(false)
		deps.log('info', 'shell chat: first identity not confirmed (legacy, chain or a field unknown): no create entry; the identity is pending')
		deps.showIdentityPending()
		return 'pgp_identity_pending'
	}
	if (ev.state === 'failed') {
		if (ev.failureCode) deps.showPgpFailure(ev.failureCode)
		return 'pgp_failed'
	}
	if (ev.state === 'undetermined') {
		deps.retry('pgp evaluate undetermined')
		return 'failed'
	}
	// ok: the native layer verified the backup and the fingerprint; restore the original identity.
	const r = await deps.restorePgp()
	if (r.ok) {
		deps.log('info', 'shell chat: original PGP identity restored; the start is retried')
		deps.retry('pgp restored', 'continue')
		return 'pgp_restored'
	}
	if (r.failure) {
		deps.showPgpFailure(r.failure)
		return 'pgp_failed'
	}
	// already_exists = the local identity already matches the backup and is usable. The account is
	// confirmed for this process (no further pgpRestore), and the start continues once (no notice, no pgp_not_ready).
	if (r.code === 'already_exists') {
		if (accountKey) confirmedAccounts.add(accountKey)
		deps.log('info', 'shell chat: the identity already matches the backup (already_exists); the account is confirmed for this session; the start continues')
		deps.retry('pgp already matches the backup', 'continue')
		return 'pgp_restored'
	}
	// (native rule): not_ready = an inconsistent record or a locked store, nothing written. It ends this session
	// with the notice; the user may replace explicitly (3, 類 4). No automatic retry.
	if (r.code === 'not_ready') {
		deps.log('warn', 'shell chat: the restore is not ready (inconsistent record or locked store); this session stops, no automatic retry; the user may replace explicitly')
		deps.showPgpFailure('pgp_restore_not_ready')
		return 'pgp_failed'
	}
	deps.retry(`pgp restore ${r.code}`)
	return 'failed'
}

/**
 * G1 init from the chain. Off in the integration branch: the entry path (reachNativeWallet) is the only G1 initiator
 * Only one of the two may be enabled; rejected enabling both. Enabling this switch requires the entry
 * path to be disabled in the same change.
 */
export const SHELL_G1_INIT_ENABLED = false
