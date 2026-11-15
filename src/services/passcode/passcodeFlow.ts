/**
 * Passcode flow state machine (transitions read from passcode-vectors.v1.json `stateMachine`, including the
 * three PWA-added transitions accepted in the 10th batch). Pure: no UI, no storage. The UI and the native overlay both
 * drive the same table, so a transition that is not in the table is refused.
 */
import vectors from './passcode-vectors.v1.json'

export type FlowMode = 'enable' | 'change' | 'disable' | 'unlock'
export type FlowState = 'setup_new' | 'setup_confirm' | 'verify_old' | 'verify' | 'unlock' | 'done'
export type FlowEvent = 'submit_valid' | 'submit_invalid' | 'submit_match' | 'submit_mismatch' | 'submit_wrong' | 'cooldown' | 'cancel' | 'internal_error'
export type FlowResult = 'ok' | 'cancelled' | 'backoff' | 'error'

export interface FlowTransition {
	mode: string
	from: string
	event: string
	to: FlowState
	result?: FlowResult
	message?: string | null
	pwaAdded?: boolean
	/** 14th batch: the change setup rows that the vector file added */
	specAdded?: boolean
}

export interface FlowStep {
	to: FlowState
	result?: FlowResult
	message?: string | null
}

/** Start state of each mode. */
export const FLOW_START: Record<FlowMode, FlowState> = {
	enable: 'setup_new',
	change: 'verify_old',
	disable: 'verify',
	unlock: 'unlock',
}

export const FLOW_TRANSITIONS: readonly FlowTransition[] = (vectors as { stateMachine: { transitions: FlowTransition[] } }).stateMachine.transitions

function findTransition(mode: string, from: FlowState, event: FlowEvent): FlowTransition | undefined {
	const exact = FLOW_TRANSITIONS.find((t) => t.mode === mode && t.from === from && t.event === event)
	return exact ?? FLOW_TRANSITIONS.find((t) => (t.mode === '*' || t.mode === mode) && (t.from === '*' || t.from === from) && t.event === event)
}

/** Next step for (mode, state, event), or null when the table has no such transition. Exact matches win over `*`. */
export function nextFlowStep(mode: FlowMode, from: FlowState, event: FlowEvent): FlowStep | null {
	const t = findTransition(mode, from, event)
	if (!t) return null
	return { to: t.to, result: t.result as FlowResult | undefined, message: t.message ?? null }
}

/** Snapshot of one flow run: what the UI shows. `message` is a key (policy, mismatch, wrong), never a value. */
export interface FlowSnapshot {
	mode: FlowMode
	state: FlowState
	result?: FlowResult
	message: string | null
	done: boolean
}

export function startFlow(mode: FlowMode): FlowSnapshot {
	return { mode, state: FLOW_START[mode], message: null, done: false }
}

/** Applies one event. An event with no transition in the table is refused: the snapshot is returned unchanged. */
export function applyFlowEvent(snap: FlowSnapshot, event: FlowEvent): FlowSnapshot {
	if (snap.done) return snap
	const step = nextFlowStep(snap.mode, snap.state, event)
	if (!step) return snap
	return { ...snap, state: step.to, result: step.result, message: step.message ?? null, done: step.to === 'done' }
}
