/**
 * The native inbound generation.
 *
 * The native layer tells the page its current generation with the event `{type: "inboundGeneration", generation: N}` on the
 * chat-module channel. It sends the event when `init` succeeds and at every advance (clear, account switch, failed clear). The page
 * keeps the latest value and never works the number out itself. A value that is not a non-negative safe integer is ignored, so it
 * never replaces a good one.
 */
import { NATIVE_EVENT_NAMES, eventPayloadOf } from './nativeKeyState'

export const INBOUND_GENERATION_EVENT = 'inboundGeneration'
/** The hello capability that says the native layer announces the generation and needs the field. */
export const INBOUND_GENERATION_CAPABILITY = 'inbound.generation.v1'

/** a non-negative integer, 0 to 2^53 − 1 (the same integer rule as reqId). */
export const isInboundGeneration = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

let latest: number | null = null

/**
 * Records the value of an event payload when it is a generation event with a valid number. Returns true when the value was kept.
 * Any other payload is left alone.
 */
export function recordInboundGenerationEvent(payload: Record<string, unknown> | null | undefined): boolean {
	if (!payload || payload.type !== INBOUND_GENERATION_EVENT) return false
	if (!isInboundGeneration(payload.generation)) return false
	latest = payload.generation
	return true
}

/** The latest generation the native layer has announced, or null before the first announcement. */
export const latestInboundGeneration = (): number | null => latest

/**
 * Listens for the generation event on the chat-module channel (both shells). Idempotent. Returns the remover, or null without a
 * window.
 */
let installed: (() => void) | null = null
export function installInboundGenerationWatcher(): (() => void) | null {
	if (typeof window === 'undefined') return null
	if (installed) return installed
	const listener = (ev: Event) => {
		recordInboundGenerationEvent(eventPayloadOf(ev))
	}
	for (const name of NATIVE_EVENT_NAMES) window.addEventListener(name, listener)
	installed = () => {
		for (const name of NATIVE_EVENT_NAMES) window.removeEventListener(name, listener)
		installed = null
	}
	return installed
}

/** Tests only: forgets the stored value. */
export function resetInboundGenerationForTests(): void {
	latest = null
}
