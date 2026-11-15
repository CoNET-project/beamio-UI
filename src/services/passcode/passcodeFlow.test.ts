/**
 * Passcode flow. Every transition of the shared vector file is checked; a transition that is not in
 * the table is refused.
 */
import vectors from './passcode-vectors.v1.json'
import { FLOW_START, FLOW_TRANSITIONS, applyFlowEvent, nextFlowStep, startFlow, type FlowEvent, type FlowMode, type FlowState } from './passcodeFlow'

describe('transition table = shared vectors', () => {
	it('has every vector transition and the three PWA-added ones', () => {
		expect(FLOW_TRANSITIONS).toHaveLength(vectors.stateMachine.transitions.length)
		expect(FLOW_TRANSITIONS.filter((t) => t.pwaAdded).map((t) => t.event).sort()).toEqual(['cooldown', 'internal_error', 'submit_mismatch'])
		expect(FLOW_TRANSITIONS.filter((t) => t.specAdded)).toHaveLength(2)
	})

	for (const t of vectors.stateMachine.transitions as Array<{ mode: string; from: string; event: string; to: FlowState; result?: string; message?: string | null }>) {
		it(`${t.mode} ${t.from} --${t.event}--> ${t.to}${t.result ? ` (${t.result})` : ''}`, () => {
			const modes: FlowMode[] = t.mode === '*' ? ['enable', 'change', 'disable', 'unlock'] : [t.mode as FlowMode]
			const froms: FlowState[] = t.from === '*' ? ['setup_new', 'setup_confirm', 'verify_old', 'verify', 'unlock'] : [t.from as FlowState]
			for (const m of modes) {
				for (const f of froms) {
					const step = nextFlowStep(m, f, t.event as FlowEvent)
					if (t.mode !== '*' && t.from !== '*') {
						expect(step).toEqual({ to: t.to, result: t.result ?? undefined, message: t.message ?? null })
					} else {
						expect(step).not.toBeNull()
						expect(step!.to).toBe(t.to)
					}
				}
			}
		})
	}
});

describe('refusals and flows', () => {
	it('a transition that is not in the table is refused', () => {
		expect(nextFlowStep('unlock', 'setup_new', 'submit_match')).toBeNull()
		expect(nextFlowStep('disable', 'setup_new', 'submit_wrong')).toBeNull()
	})

	it('enable: valid, then matching confirmation, ends ok', () => {
		let s = FLOW_START.enable
		s = nextFlowStep('enable', s, 'submit_valid')!.to
		expect(s).toBe('setup_confirm')
		expect(nextFlowStep('enable', s, 'submit_match')).toEqual({ to: 'done', result: 'ok', message: null })
	})

	it('change setup states come from the vector table (14th batch rows, no fallback)', () => {
		expect(nextFlowStep('change', 'setup_new', 'submit_valid')).toEqual({ to: 'setup_confirm', result: undefined, message: null })
		expect(nextFlowStep('change', 'setup_new', 'submit_invalid')).toEqual({ to: 'setup_new', result: undefined, message: 'policy' })
	})

	it('change: old passcode first, then the new one, ends ok', () => {
		let s = FLOW_START.change
		expect(nextFlowStep('change', s, 'submit_wrong')).toEqual({ to: 'verify_old', result: undefined, message: 'wrong' })
		s = nextFlowStep('change', s, 'submit_match')!.to
		expect(s).toBe('setup_new')
		s = nextFlowStep('change', s, 'submit_valid')!.to
		expect(nextFlowStep('change', s, 'submit_match')).toEqual({ to: 'done', result: 'ok', message: null })
	})

	it('unlock: cooldown ends with backoff; cancel from any state ends cancelled', () => {
		expect(nextFlowStep('unlock', 'unlock', 'cooldown')).toEqual({ to: 'done', result: 'backoff', message: null })
		for (const m of ['enable', 'change', 'disable', 'unlock'] as FlowMode[]) {
			expect(nextFlowStep(m, FLOW_START[m], 'cancel')).toEqual({ to: 'done', result: 'cancelled', message: null })
		}
	})

	it('an internal error ends with the generic error result from any state', () => {
		expect(nextFlowStep('disable', 'verify', 'internal_error')).toEqual({ to: 'done', result: 'error', message: null })
	})
})

describe('flow snapshot (what the UI runs)', () => {
	it('enable: setup_new → setup_confirm → done ok', () => {
		let snap = startFlow('enable')
		expect(snap.state).toBe('setup_new')
		snap = applyFlowEvent(snap, 'submit_valid')
		expect(snap).toMatchObject({ state: 'setup_confirm', done: false })
		snap = applyFlowEvent(snap, 'submit_match')
		expect(snap).toMatchObject({ state: 'done', result: 'ok', done: true })
	})

	it('a mismatch goes back to setup_new with the mismatch message key', () => {
		let snap = applyFlowEvent(startFlow('enable'), 'submit_valid')
		snap = applyFlowEvent(snap, 'submit_mismatch')
		expect(snap).toMatchObject({ state: 'setup_new', message: 'mismatch', done: false })
	})

	it('an event with no transition leaves the snapshot unchanged', () => {
		const snap = startFlow('unlock')
		expect(applyFlowEvent(snap, 'submit_valid')).toBe(snap)
	})

	it('a finished flow ignores further events', () => {
		const done = applyFlowEvent(startFlow('disable'), 'cancel')
		expect(done).toMatchObject({ done: true, result: 'cancelled' })
		expect(applyFlowEvent(done, 'submit_match')).toBe(done)
	})

	it('change: verify_old → setup_new → setup_confirm → done ok', () => {
		let snap = startFlow('change')
		snap = applyFlowEvent(snap, 'submit_match')
		expect(snap.state).toBe('setup_new')
		snap = applyFlowEvent(snap, 'submit_valid')
		snap = applyFlowEvent(snap, 'submit_match')
		expect(snap).toMatchObject({ result: 'ok', done: true })
	})
})
