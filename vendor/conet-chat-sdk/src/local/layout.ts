/**
 * Layout size records. Keys, buckets, estimates and the correction average.
 * Estimates are never written to the store; only real measurements are.
 */

import type { ChatKind, MediaState, Viewport } from './types.js'

export const LAYOUT_VERSION = 1
/** Bubble horizontal padding used by the estimate. */
const BUBBLE_PAD_PT = 24
const EMA_ALPHA = 0.2
const MIN_IMAGE_H = 120

export function widthBucket(widthPt: number): number {
	return Math.round(widthPt / 8) * 8
}

export function fontBucket(fontScale: number): number {
	return Math.min(20, Math.max(8, Math.round(fontScale * 10)))
}

export interface LayoutKey {
	wb: number
	o: 'portrait' | 'landscape'
	fb: number
	lv: number
}

export function layoutKeyOf(vp: Viewport): LayoutKey {
	return { wb: widthBucket(vp.widthPt), o: vp.orientation, fb: fontBucket(vp.fontScale), lv: vp.layoutVersion }
}

export interface EstimateInput {
	kind: ChatKind
	widthPx?: number
	heightPx?: number
	mediaState?: MediaState
}

export interface LayoutValue {
	wPt: number
	hPt: number
	measured: boolean
}

/** Per-bucket correction (real ÷ estimate), EMA α = 0.2. In memory only. */
export class EstimateCorrections {
	private ratio = new Map<string, number>()

	private static bucketKey(k: LayoutKey, kind: ChatKind): string {
		return `${k.wb}|${k.o}|${k.fb}|${k.lv}|${kind}`
	}

	factor(k: LayoutKey, kind: ChatKind): number {
		return this.ratio.get(EstimateCorrections.bucketKey(k, kind)) ?? 1
	}

	observe(k: LayoutKey, kind: ChatKind, measuredH: number, estimatedH: number): void {
		if (!(estimatedH > 0) || !(measuredH > 0)) return
		const key = EstimateCorrections.bucketKey(k, kind)
		const r = measuredH / estimatedH
		const prev = this.ratio.get(key)
		this.ratio.set(key, prev === undefined ? r : prev * (1 - EMA_ALPHA) + r * EMA_ALPHA)
	}
}

/** Estimate height and width for an item with no measurement. */
export function estimate(input: EstimateInput, vp: Viewport, corr?: EstimateCorrections): LayoutValue {
	const k = layoutKeyOf(vp)
	const fs = vp.fontScale
	const wb = k.wb
	const cap = 0.9 * vp.heightPt
	const mediaWidth = Math.min(vp.widthPt - BUBBLE_PAD_PT, 280)
	let out: LayoutValue
	switch (input.kind) {
		case 'text':
			out = { wPt: wb, hPt: 56 * fs, measured: false }
			break
		case 'image':
		case 'video': {
			if (input.mediaState === 'failed') {
				out = { wPt: mediaWidth, hPt: 88 * fs, measured: false }
				break
			}
			// v0.2: wPt = min(widthPt − 24, 280); height from the sender's size when known
			const w = Math.min(vp.widthPt - BUBBLE_PAD_PT, 280)
			const fallback = input.kind === 'video' ? 9 / 16 : 3 / 4
			const ratio = input.widthPx && input.heightPx ? input.heightPx / input.widthPx : fallback
			out = { wPt: w, hPt: clamp(w * ratio, MIN_IMAGE_H, cap), measured: false }
			break
		}
		default:
			out = { wPt: wb, hPt: 72 * fs, measured: false }
	}
	if (corr) out = { ...out, hPt: out.hPt * corr.factor(k, input.kind) }
	return out
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v))
}

/** A new measurement is written only when it differs from the stored one by more than 2pt. */
export function measurementChanged(prev: { wPt: number; hPt: number } | null, wPt: number, hPt: number): boolean {
	if (!prev) return true
	return Math.abs(prev.wPt - wPt) > 2 || Math.abs(prev.hPt - hPt) > 2
}
