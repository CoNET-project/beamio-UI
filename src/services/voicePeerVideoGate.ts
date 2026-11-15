/**
 * Peer camera on/off for the call screen.
 *
 * The peer says it turned its camera off with `voice_video_disable_v1` and on
 * with `voice_video_enable_v1`; both carry the peer's send time (`timestamp`,
 * peer clock). Video frames (`BJP2`) carry their capture time on the same
 * clock, so a frame captured at or before the "off" time is a late frame from
 * before the camera went off and must never bring the picture back.
 *
 * - A control older than the last one applied is stale (a repeated "off" that
 *   arrives after the camera came back on) and is ignored.
 * - A frame captured after the "off" time means the camera is on again, even
 *   if the "on" control was lost.
 * - `BJPG` frames have no capture time; they are shown only while the camera
 *   is on.
 */
export type PeerVideoGate = {
	/** Peer time of the newest enable/disable control applied (0 = none). */
	stateTs: number
	/** Peer time of the newest "camera off" (0 = never off). */
	offAt: number
	/** Camera currently off. */
	off: boolean
}

export const newPeerVideoGate = (): PeerVideoGate => ({ stateTs: 0, offAt: 0, off: false })

const peerTime = (ts: unknown): number => {
	const n = Number(ts)
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * Apply an enable/disable control. Returns false when it is stale (older than
 * a control already applied), so the caller leaves the screen as it is.
 */
export const applyPeerVideoControl = (gate: PeerVideoGate, kind: 'enable' | 'disable', timestamp: unknown): boolean => {
	const ts = peerTime(timestamp)
	if (ts > 0 && ts < gate.stateTs) return false
	if (ts > 0) gate.stateTs = ts
	if (kind === 'disable') {
		gate.off = true
		if (ts > gate.offAt) gate.offAt = ts
	} else {
		gate.off = false
	}
	return true
}

/** Late frame: captured at or before the last "off", or without a capture time while off. */
export const isStalePeerFrame = (gate: PeerVideoGate, captureMs: number): boolean => (
	captureMs > 0 ? captureMs <= gate.offAt : gate.off
)

/**
 * Should this arriving frame be shown? A frame captured after the last "off"
 * also marks the camera as on again (its "on" control may have been lost).
 */
export const acceptPeerFrame = (gate: PeerVideoGate, captureMs: number): boolean => {
	if (isStalePeerFrame(gate, captureMs)) return false
	if (captureMs > 0 && gate.off) gate.off = false
	return true
}

/** When to send `voice_video_disable_v1` again (ms after the camera went off). A single control can be dropped. */
export const VIDEO_OFF_REPEAT_MS = [0, 1500, 4000] as const
