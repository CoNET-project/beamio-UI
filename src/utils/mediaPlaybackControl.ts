import { useRef } from 'react'
import { mediaManifestIdentity } from './mediaFragment'

export type MediaKind = 'voice' | 'video'

/** Message for a rejected play(). */
export function playbackErrorMessage(kind: MediaKind, error: unknown): string {
	const name = (error as { name?: string } | null)?.name || ''
	const what = kind === 'voice' ? 'Voice message' : 'Video'
	if (name === 'NotSupportedError') return `${what} format is not supported on this device.`
	if (name === 'NotAllowedError') return `Tap again to play the ${kind === 'voice' ? 'voice message' : 'video'}.`
	return `${what} could not be played.`
}

type PlayableElement = Pick<HTMLMediaElement, 'paused' | 'play' | 'pause'>

export type ToggleResult = { state: 'playing' } | { state: 'paused' } | { state: 'error'; message: string }

/**
 * Play when paused, pause when playing. play() is called in the same tick as
 * the tap, so the user gesture still counts.
 */
export async function toggleMediaPlayback(el: PlayableElement | null, kind: MediaKind): Promise<ToggleResult> {
	if (!el) return { state: 'error', message: playbackErrorMessage(kind, null) }
	if (!el.paused) {
		el.pause()
		return { state: 'paused' }
	}
	try {
		await el.play()
		return { state: 'playing' }
	} catch (error) {
		return { state: 'error', message: playbackErrorMessage(kind, error) }
	}
}

/**
 * The same manifest object as long as its fragment/key/iv do not change.
 * Chat rebuilds message objects on each profile refresh; keying a player's
 * download effect on the object re-downloaded the media and revoked the blob
 * URL of a clip that was playing.
 */
export function useStableMediaManifest<T extends { fragmentHash?: string; key?: string; iv?: string }>(manifest: T): T {
	const ref = useRef<{ id: string; manifest: T } | null>(null)
	const id = mediaManifestIdentity(manifest)
	if (!ref.current || ref.current.id !== id) ref.current = { id, manifest }
	return ref.current.manifest
}

type VideoLike = Pick<HTMLMediaElement, 'paused' | 'play' | 'ended' | 'duration' | 'currentTime'>

/**
 * Video play button. Android/WebView often leaves short clips at their end
 * after load/ended, so play() fires ended at once and looks like "cannot
 * play": seek to 0 first and retry once after 50 ms if still paused.
 * An AbortError (this play() interrupted by the retry, a seek or a pause) is
 * not a failure, and no error is shown once the video is playing.
 */
export function startVideoFromTap(
	video: VideoLike,
	onError: (message: string) => void,
	setTimer: (cb: () => void, ms: number) => unknown = (cb, ms) => setTimeout(cb, ms),
): void {
	const nearEnd =
		video.ended ||
		(Number.isFinite(video.duration) && video.duration > 0 && video.currentTime >= video.duration - 0.05)
	if (nearEnd) {
		try {
			video.currentTime = 0
		} catch {
			/* some WebViews throw if seek before metadata */
		}
	}
	const attempt = () => {
		void Promise.resolve(video.play()).catch((error: { name?: string }) => {
			if (error?.name === 'AbortError') return
			if (!video.paused) return
			onError(playbackErrorMessage('video', error))
		})
	}
	attempt()
	if (nearEnd) setTimer(() => { if (video.paused) attempt() }, 50)
}
