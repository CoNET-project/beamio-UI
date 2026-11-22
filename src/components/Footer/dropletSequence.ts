/**
 * The droplet animation sequence of the footer. Every step checks `isLive()` before it starts the next animation, so an unmounted or
 * cancelled footer never animates or writes state again. Kept apart from the component so the timing can be tested directly.
 */
export type DropletPhase = 'idle' | 'moving' | 'settling'

export interface DropletControls {
	set(values: Record<string, unknown>): void
	start(values: Record<string, unknown>): Promise<unknown>
	stop(): void
}

export async function runDropletSequence(opts: {
	controls: DropletControls
	isLive: () => boolean
	startX: number
	setPhase: (p: DropletPhase) => void
}): Promise<void> {
	const { controls, isLive, startX, setPhase } = opts
	if (!isLive()) return
	controls.set({ opacity: 1, x: `${startX * 100}%`, borderRadius: 12, scaleX: 0.5, scaleY: 0.5 })
	setPhase('moving')

	await controls.start({ opacity: 1, borderRadius: 12, scaleX: 1.1, scaleY: 0.9, transition: { duration: 0.12, ease: [0.55, 0.0, 1.0, 0.45] } })
	if (!isLive()) return
	setPhase('settling')

	await controls.start({ borderRadius: 12, scaleX: 1.272, scaleY: 1.152, transition: { duration: 0.14, ease: [0.55, 0.0, 1.0, 0.45] } })
	if (!isLive()) return

	await controls.start({ borderRadius: 12, scaleX: 1, scaleY: 1, transition: { duration: 0.55, ease: [0.2, 0.9, 0.2, 1] } })
	if (!isLive()) return
	setPhase('idle')
}
