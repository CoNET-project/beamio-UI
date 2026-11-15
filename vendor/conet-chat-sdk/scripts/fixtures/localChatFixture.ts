/**
 * Deterministic synthetic chat fixture for the local store tests (spec, reduced).
 * Pure synthetic data: no real chat, no real keys, no real media. Same seed → same output.
 */

import type { IncomingRecord, ChatKind, MediaInfo } from '../../src/local/types.js'
import type { SyncRecord } from '../../src/local/store.js'

/** sfc32 PRNG (fixed seed → byte-identical output). */
export function sfc32(seed: number): () => number {
	let a = 0x9e3779b9 ^ seed
	let b = 0x243f6a88 ^ (seed << 3)
	let c = 0xb7e15162 ^ (seed >>> 5)
	let d = 1
	const next = () => {
		a >>>= 0
		b >>>= 0
		c >>>= 0
		d >>>= 0
		const t = (((a + b) | 0) + d) | 0
		d = (d + 1) | 0
		a = b ^ (b >>> 9)
		b = (c + (c << 3)) | 0
		c = (c << 21) | (c >>> 11)
		c = (c + t) | 0
		return (t >>> 0) / 4294967296
	}
	for (let i = 0; i < 15; i++) next()
	return next
}

export interface FixtureMessage {
	convKey: string
	dir: 'in' | 'out'
	sortTs: number
	sendId: string | null
	kind: ChatKind
	body: string
	media?: MediaInfo
	revision: number
	deleted: boolean
	cid: string
}

export interface FixtureConv {
	convKey: string
	messages: FixtureMessage[]
}

export interface FixtureOptions {
	seed: number
	convs: number
	messagesPerConv: number
	/** Fraction of messages carrying media (0.3). */
	mediaRatio?: number
	/** Fraction forced to share a timestamp with the previous message (≥ 5%). */
	sameMsRatio?: number
	/** Fraction with an empty sendId (10%). */
	noSendIdRatio?: number
	/** Fraction revised once (1%). */
	reviseRatio?: number
	/** Fraction tombstoned (0.5%). */
	tombstoneRatio?: number
	/** Conversation key prefix; accounts can share keys. */
	convPrefix?: string
	tsBase?: number
}

const RATIOS = { media: 0.3, sameMs: 0.05, noSendId: 0.1, revise: 0.01, tombstone: 0.005 }

export function buildFixture(o: FixtureOptions): { convs: FixtureConv[]; revisions: FixtureMessage[] } {
	const rnd = sfc32(o.seed)
	const mediaRatio = o.mediaRatio ?? RATIOS.media
	const sameMs = o.sameMsRatio ?? RATIOS.sameMs
	const noSend = o.noSendIdRatio ?? RATIOS.noSendId
	const reviseR = o.reviseRatio ?? RATIOS.revise
	const tombR = o.tombstoneRatio ?? RATIOS.tombstone
	const prefix = o.convPrefix ?? 'conv'
	const tsBase = o.tsBase ?? 1_760_000_000_000
	const convs: FixtureConv[] = []
	const revisions: FixtureMessage[] = []
	const ratios = [
		{ kind: 'image' as const, aspect: { w: 4, h: 3 } },
		{ kind: 'image' as const, aspect: { w: 3, h: 4 } },
		{ kind: 'video' as const, aspect: { w: 16, h: 9 } },
		{ kind: 'video' as const, aspect: { w: 9, h: 16 } },
		{ kind: 'image' as const, aspect: { w: 1, h: 1 } },
	]
	for (let c = 0; c < o.convs; c++) {
		const convKey = `0x${(prefix + c).padStart(4, '0')}`
		const messages: FixtureMessage[] = []
		let ts = tsBase + c * 1000
		for (let n = 0; n < o.messagesPerConv; n++) {
			if (rnd() >= sameMs) ts += 1 + Math.floor(rnd() * 5000) // bursts: many share ms
			const dir: 'in' | 'out' = rnd() < 0.5 ? 'in' : 'out'
			const hasMedia = rnd() < mediaRatio
			const isTomb = rnd() < tombR
			let kind: ChatKind = 'text'
			let media: MediaInfo | undefined
			const marker = `FIXTURE-${o.seed}-${c}-${n}`
			let body = JSON.stringify({ text: `${marker} hello ${n}`, from: dir === 'out' ? 'me' : 'them', createdAt: ts })
			if (hasMedia) {
				const pick = ratios[Math.floor(rnd() * ratios.length)]
				kind = pick.kind
				media = {
					cid: `m-${o.seed}-${c}-${n}`,
					mime: pick.kind === 'video' ? 'video/mp4' : 'image/jpeg',
					widthPx: pick.aspect.w * 100,
					heightPx: pick.aspect.h * 100,
					state: 'pending',
				}
				body = JSON.stringify({ text: '', fileMessage: { mediaKind: pick.kind }, marker, createdAt: ts })
			}
			const sendId = rnd() < noSend ? null : `s-${o.seed}-${c}-${n}`
			const msg: FixtureMessage = {
				convKey,
				dir,
				sortTs: ts,
				sendId,
				kind,
				body: isTomb ? '' : body,
				media,
				revision: 0,
				deleted: isTomb,
				cid: `cid-${o.seed}-${c}-${n}`,
			}
			messages.push(msg)
			if (!isTomb && rnd() < reviseR) {
				revisions.push({ ...msg, body: body.replace('hello', 'edited'), revision: 1, cid: `cid-${o.seed}-${c}-${n}-r1` })
			}
		}
		convs.push({ convKey, messages })
	}
	return { convs, revisions }
}

/** Sync records (what the manifest would list) + the fetch table (what decryption would return). */
export function toSync(convs: FixtureConv[], revisions: FixtureMessage[]): { records: SyncRecord[]; table: Map<string, IncomingRecord> } {
	const records: SyncRecord[] = []
	const table = new Map<string, IncomingRecord>()
	const all = [...convs.flatMap((c) => c.messages), ...revisions]
	for (const m of all) {
		records.push({ convKey: m.convKey, dir: m.dir, sortTs: m.sortTs, sendId: m.sendId, cid: m.cid, revision: m.revision })
		table.set(m.cid, toIncoming(m))
	}
	return { records, table }
}

export function toIncoming(m: FixtureMessage): IncomingRecord {
	return {
		convKey: m.convKey,
		dir: m.dir,
		sortTs: m.sortTs,
		sendId: m.sendId,
		kind: m.kind,
		body: m.body,
		cid: m.cid,
		revision: m.revision,
		deleted: m.deleted,
		media: m.media,
	}
}

/** Expected visible timeline for one conversation: live rows, latest revision, sorted by (sort_ts, stable_id). */
export function truthFor(convs: FixtureConv[], revisions: FixtureMessage[], convKey: string): FixtureMessage[] {
	const conv = convs.find((c) => c.convKey === convKey)
	if (!conv) return []
	const latest = new Map<string, FixtureMessage>()
	const key = (m: FixtureMessage) => m.sendId ?? m.cid
	for (const m of conv.messages) latest.set(key(m), m)
	for (const r of revisions) if (r.convKey === convKey && latest.has(key(r))) latest.set(key(r), r)
	return [...latest.values()].filter((m) => !m.deleted)
}
