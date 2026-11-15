/**
 * the wiring of the account-switch rules. The worker bridge cannot be loaded under jest
 * (its worker import), and chat.ts and App.tsx are large, so the wiring is checked by source. The decisions themselves are run-time
 * tested (historyClientBinding.test.ts, historyRestoreApply.test.ts). SYNTHETIC values only.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '..')
const bridge = fs.readFileSync(path.join(__dirname, 'chatWorkerBridge.ts'), 'utf8')
const chat = fs.readFileSync(path.join(__dirname, 'chat.ts'), 'utf8')
const app = fs.readFileSync(path.join(SRC, 'App.tsx'), 'utf8')

describe('a gossip start restarts a client of another account', () => {
	it('initChat asks the decision, skips only on skip, and stops the old client on restart', () => {
		expect(chat).toContain('const decision = gossipStartDecision({ gossip, bound: boundAccountOfActiveClient(), account: pageAccount, shell: isShellContext() })')
		expect(chat).toContain("if (decision === 'skip') {")
		expect(chat).toContain("if (decision === 'restart') {")
		expect(chat).toContain("clearGossipListenSession('account_changed')")
		// The old gate (a gossip flag alone) is gone.
		expect(chat).not.toMatch(/if \(gossip\) \{\s*chatBootLog\('initChat skipped: gossip already active'/)
	})
	it('the App init does not return early for a client of another account', () => {
		expect(app).toContain("gossipStartDecision({ gossip: true, bound: boundAccountOfActiveClient(), account: historyAccountNow(), shell: isShellContext() }) === 'skip'")
	})
	it('the bridge exports the account of the page, and the App sets it while mounted', () => {
		expect(bridge).toContain('export const setCurrentAccountGetter = (fn: (() => string) | null): void => {')
		expect(app).toContain('setCurrentAccountGetter(() => historyAccountNow())')
		expect(app).toContain('setCurrentAccountGetter(null)')
	})
});

describe('a new client gets its own history loads', () => {
	it('a new worker client resets the load gate when it starts', () => {
		const start = bridge.indexOf('const startWorkerGossipListenInternal = async')
		expect(start).toBeGreaterThan(0)
		const body = bridge.slice(start, start + 400)
		expect(body).toContain('stopWorkerGossip()')
		expect(body).toContain('historyLoadGate.reset()')
	})
})

describe('an inbound line of another account is not delivered', () => {
	it('the message handler passes a line only when its client serves the current account', () => {
		const at = bridge.indexOf("client.on('message', (env) => {")
		expect(at).toBeGreaterThan(0)
		const handler = bridge.slice(at, at + 1200)
		expect(handler).toContain('const current = currentAccountGetter ? currentAccountGetter() : null')
		expect(handler).toContain('inboundLineForAccount(eoaAddress.toLowerCase(), current)')
		expect(handler).toContain('if (env.line && forThisAccount) p.onLine(env.line)')
		// The acknowledgement is prepared only for a line that is delivered.
		expect(handler.indexOf('forThisAccount && env.armorHash')).toBeGreaterThan(0)
	})
	it('the envelope has no recipient field: the sender side in chat.ts sendMessage sets from and signMessage only', () => {
		const at = chat.indexOf('const message = {\n\t\ttimestamp: Date.now(),')
		expect(at).toBeGreaterThan(0)
		const env = chat.slice(at, at + 120)
		expect(env).not.toMatch(/\bto\b|recipient/)
	})
})

describe('an account change starts the new client, and a skipped load is not dropped', () => {
	const chat2 = chat
	it('App starts the client on an account change while a live client belongs to another account', () => {
		expect(app).toContain("publishNativePwaLog('warn', '[AppShell] account changed while the listen of another account is live: restarting the listen')")
		expect(app).toContain('void initChat(setProfiles, setAllNodes, setGossip, false, handleInitChatLine)')
		// The App init and the account effect share the same line handler.
		expect(app).toContain('await initChat(setProfiles,setAllNodes, setGossip, gossipActiveRef.current, handleInitChatLine)')
	})
	it('the voice route restart does not reuse the parameters of another account', () => {
		expect(chat2).toContain('if (!listenParamsFitAccount(prev.eoaAddress, pageAccountNow)) {')
		const at = chat2.indexOf('if (!listenParamsFitAccount(prev.eoaAddress, pageAccountNow)) {')
		// The check comes before the restart that spreads the previous parameters.
		expect(at).toBeLessThan(chat2.indexOf('let started = await startWorkerGossipListen({', at))
	})
	it('a timer that fires during a load keeps its skipped request as the dirty re-run (historyLoadGate)', () => {
		const gate = fs.readFileSync(path.join(__dirname, 'historyLoadGate.ts'), 'utf8')
		expect(gate).toContain('setDirty(t.caller, t.load)')
		expect(gate).toContain('const againLoad = dirtyLoad ?? load')
	})
})

describe('the marks follow the commit, and the account effect uses the same decision', () => {
	it('the App commit merges and marks only through commitRestorePlan, for the page account', () => {
		expect(app).toContain('const result = commitRestorePlan(list, plan, historyAccountNow(), restoredHistoryKeysRef.current)')
		// The plan itself marks nothing.
		const plan = fs.readFileSync(path.join(__dirname, 'historyRestoreApply.ts'), 'utf8')
		const planFn = plan.slice(plan.indexOf('export async function planRestoreBatch'), plan.indexOf('export const markRestorePlanSeen'))
		expect(planFn).not.toContain('markHistoryEntriesSeen(')
	})
	it('the account effect keeps the previous account and decides with accountChangeAction', () => {
		expect(app).toContain('const previousAccount = prevHistoryEoaRef.current')
		expect(app).toContain('const action = accountChangeAction({')
		expect(app).toContain("if (action !== 'restart') return")
	})
	it('a reset of the gate also drops the trailing run of the client before it', () => {
		const gate = fs.readFileSync(path.join(__dirname, 'historyLoadGate.ts'), 'utf8')
		const at = gate.indexOf('reset() {')
		expect(gate.slice(at, at + 200)).toContain('trailing = null')
		expect(gate).toContain('if (myGeneration !== generation) return')
	})
})

