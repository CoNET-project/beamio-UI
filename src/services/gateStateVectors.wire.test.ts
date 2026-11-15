/**
 * Gate-state vectors (v2, the pinned package copy), wire-level check. For every vector case the command name and payload go through
 * the PWA's chat-module path (postChatModuleCommand) to a fake shell bridge. The bridge answers in the form the vector states, and
 * the PWA's watcher and status reader must react as the vector says.
 *
 * Not covered here: the payload the PWA assembles for an init (the transport's own unit tests cover it), the shell's own reads
 * (payloadRead), the init key check, and the shell record exception, which the vector file does not contain. The passcodeStatus
 * shape has no PWA reader yet; that case only checks that the watcher ignores it. SYNTHETIC vectors only; no key is read.
 */
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { installNativeNoKeyWatcher, postChatModuleCommand, readNativeWalletStatus } from './nativeKeyState'

const FIX = (name: string) => JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8'))

type GateCase = { id: string; state: string; command: string; payload: Record<string, unknown>; expect: Record<string, unknown> }
type GateVectors = { cases: GateCase[]; shellGated: string[]; shellNotGated: string[] }

const gate = FIX('gate-state-vectors.v2.json') as GateVectors

const w = window as unknown as { CashTreesIOS?: unknown }
let bridge: { chatModuleCommand: jest.Mock }

beforeEach(() => {
	bridge = { chatModuleCommand: jest.fn() }
	w.CashTreesIOS = bridge
})

afterEach(() => {
	delete w.CashTreesIOS
})

/** The shell's answer in the form the vector states (ok for `ok` and `allowed`; otherwise a refused ack with that code). */
function answerFor(c: GateCase, reqId: number): Record<string, unknown> {
	const code = c.expect.code as string
	if (code === 'ok' || code === 'allowed') return { type: 'ack', reqId, ok: true }
	return { type: 'ack', reqId, ok: false, error: code }
}

function shellAnswers(answer: Record<string, unknown>): void {
	window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: answer } }))
}

/** How many times the import route would be raised by this answer. */
function importRouteRaisedBy(answer: Record<string, unknown>): number {
	let raised = 0
	const remove = installNativeNoKeyWatcher(() => {
		raised += 1
	})
	shellAnswers(answer)
	remove?.()
	return raised
}

/** The command the PWA put on the shell bridge, and its reqId. */
function lastSentCommand(): { type: string; reqId: number; payload?: unknown } {
	const call = bridge.chatModuleCommand.mock.calls[bridge.chatModuleCommand.mock.calls.length - 1]
	return (call[0] as { command: { type: string; reqId: number; payload?: unknown } }).command
}

describe('the gate vector file is the pinned package copy', () => {
	it('the file is byte-identical to the pinned package copy (sha256 34dcaf66…)', () => {
		const hash = createHash('sha256').update(readFileSync(join(__dirname, '__fixtures__', 'gate-state-vectors.v2.json'))).digest('hex')
		expect(hash).toBe('34dcaf66d4334c8a02e3706fa64f44fed6279657b2774f2f69005efb952fdbaa')
	})

	it('146 cases; 15 shell-gated and 13 not gated names, with no name in both lists', () => {
		expect(gate.cases).toHaveLength(146)
		expect(gate.shellGated).toHaveLength(15)
		expect(gate.shellNotGated).toHaveLength(13)
		expect(gate.shellGated.filter((n) => gate.shellNotGated.includes(n))).toEqual([])
	})

	it('the 26 shellNotGated cases (13 names in G0 and G1) are in the file and are sent on the wire below', () => {
		const notGated = gate.cases.filter((c) => gate.shellNotGated.includes(c.command))
		expect(notGated).toHaveLength(26)
		expect(notGated.filter((c) => c.state === 'G0')).toHaveLength(13)
		expect(notGated.filter((c) => c.state === 'G1')).toHaveLength(13)
	})
})

describe('wire: every chat-module vector command reaches the shell bridge with its name and payload unchanged', () => {
	// Scope: only commands sent through postChatModuleCommand. Shell-layer calls that bypass the
	// chat-module channel (for example saveFile through callAndroidBridge) are not covered here.
	it('the command name and payload that the PWA sends equal the vector case', () => {
		gate.cases.forEach((c, i) => {
			bridge.chatModuleCommand.mockClear()
			const reqId = i + 1
			expect(postChatModuleCommand({ type: c.command, reqId, payload: c.payload })).toBe(true)
			expect(bridge.chatModuleCommand).toHaveBeenCalledTimes(1)
			const sent = lastSentCommand()
			expect(sent.type).toBe(c.command)
			expect(sent.reqId).toBe(reqId)
			expect(sent.payload).toEqual(c.payload)
		})
	})
})

describe('no-key and not-ready answers through the PWA watcher', () => {
	it('every answer in the form no_key raises the import route once; every other answer raises nothing', () => {
		const withCode = gate.cases.filter((c) => typeof c.expect.code === 'string')
		expect(withCode.length).toBeGreaterThan(90)
		withCode.forEach((c, i) => {
			const raised = importRouteRaisedBy(answerFor(c, i + 1))
			expect(raised).toBe(c.expect.code === 'no_key' ? 1 : 0)
		})
	})

	it('not_ready (G1) and init answers never raise the import route', () => {
		const held = gate.cases.filter((c) => c.expect.code === 'not_ready' || c.command === 'init')
		expect(held.length).toBeGreaterThan(0)
		held.forEach((c, i) => {
			expect(importRouteRaisedBy(answerFor(c, i + 1))).toBe(0)
		})
	})
})

describe('status readers', () => {
	it('walletStatus G1 (not_ready) is read by the PWA reader as not_ready and raises nothing', async () => {
		const c = gate.cases.find((x) => x.id === 'G1-NK-S1')
		expect(c).toBeDefined()
		let raised = 0
		const remove = installNativeNoKeyWatcher(() => {
			raised += 1
		})
		const pending = readNativeWalletStatus(200)
		const sent = lastSentCommand()
		expect(sent.type).toBe('walletStatus')
		shellAnswers({ type: 'ack', reqId: sent.reqId, ok: true, result: { status: c!.expect.status } })
		await expect(pending).resolves.toBe(c!.expect.status)
		remove?.()
		expect(raised).toBe(0)
	})

	it('passcodeStatus G1 (hasKey, set, locked) has no PWA reader; the watcher ignores the reply shape', () => {
		const c = gate.cases.find((x) => x.id === 'G1-NK-S2')
		expect(c).toBeDefined()
		const { payloadRead: _ignored, ...reply } = c!.expect
		expect(_ignored).toBe(false)
		expect(importRouteRaisedBy({ type: 'ack', reqId: 1, ok: true, result: reply })).toBe(0)
	})
})

describe('the rejected-name cases (8)', () => {
	it('the 8 rejected-name cases are present: G0 answers no_key and G1 answers not_ready, for the four names', () => {
		const rj = gate.cases.filter((c) => c.id.includes('-RJ-'))
		expect(rj).toHaveLength(8)
		const names = ['notifyVoiceMicReady', 'queryIncomingCallOutcome', 'startNativeVoiceMic', 'cacheCallerAvatars']
		for (const n of names) {
			const g0 = rj.find((c) => c.id === `G0-RJ-${n}`)
			const g1 = rj.find((c) => c.id === `G1-RJ-${n}`)
			expect(g0?.command).toBe(n)
			expect(g0?.state).toBe('G0')
			expect(g0?.expect.code).toBe('no_key')
			expect(g1?.command).toBe(n)
			expect(g1?.state).toBe('G1')
			expect(g1?.expect.code).toBe('not_ready')
		}
	})

	it('each rejected-name answer raises the import route only for no_key (G0), and never for not_ready (G1)', () => {
		const rj = gate.cases.filter((c) => c.id.includes('-RJ-'))
		rj.forEach((c, i) => {
			expect(importRouteRaisedBy(answerFor(c, 900 + i))).toBe(c.expect.code === 'no_key' ? 1 : 0)
		})
	})
})
