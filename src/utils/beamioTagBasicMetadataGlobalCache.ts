/**
 * beamioTag（search-users 档案）基础 metadata 全局表：不按 EOA 隔离，按 tag / 地址索引。
 * 本地优先；后台 search-users 命中后再写入，供各页面共用。
 */

import { ethers } from 'ethers'

const PREFIX = 'beamio:beamioTagBasicMeta:v1:'
const MAX_ENTRY_JSON_CHARS = 48_000
const MAX_INDEX_ENTRIES_SOFT = 2400

export type BeamioTagBasicMetadata = {
	username: string
	address: string
	image: string
	first_name: string
	last_name: string
	created_at: number
	follow_count: string
	follower_count: string
}

type StoredEntry = {
	v: 1
	savedAt: number
	meta: BeamioTagBasicMetadata
}

const memory = new Map<string, BeamioTagBasicMetadata>()

/**
 * 2026-11-17 rule (#1, UN-04/05): an address is case-insensitive, so its index key is lower case. A BeamioTag is case-sensitive on chain
 * (keccak256 of the exact name), so its index key keeps the exact name. Alice and alice are two keys.
 */
function indexKey(kind: 'addr' | 'tag', value: string): string {
	return `${PREFIX}${kind}:${kind === 'addr' ? value.toLowerCase() : value}`
}

function parseEntry(raw: string): BeamioTagBasicMetadata | null {
	try {
		const p = JSON.parse(raw) as StoredEntry
		if (p?.v !== 1 || !p.meta || typeof p.meta !== 'object') return null
		const m = p.meta
		if (!m.address || typeof m.address !== 'string') return null
		return m
	} catch {
		return null
	}
}

function peekRaw(kind: 'addr' | 'tag', value: string): BeamioTagBasicMetadata | null {
	const k = indexKey(kind, value)
	const mem = memory.get(k)
	if (mem) return mem
	if (typeof window === 'undefined') return null
	try {
		const raw = localStorage.getItem(k)
		if (!raw || raw.length > MAX_ENTRY_JSON_CHARS) return null
		const meta = parseEntry(raw)
		if (meta) memory.set(k, meta)
		return meta
	} catch {
		return null
	}
}

/**
 * 按当前搜索词尝试命中：完整地址 → addr 索引；否则 → tag 索引。The tag hit is exact: the cached username must equal the query as typed
 * (after trim and the leading @). A different case is a miss and goes to the server (#1); an old entry keyed in lower case for a
 * name written in another case is also a miss (it is kept, not deleted or migrated).
 */
export function peekBeamioTagBasicMetadataForQuery(keyward: string): BeamioTagBasicMetadata | null {
	const q: string = String(keyward ?? '').trim()
	if (!q) return null
	if (ethers.isAddress(q)) {
		return peekRaw('addr', ethers.getAddress(q).toLowerCase())
	}
	const tag = String(keyward ?? '').trim().replace(/^@+/, '').trim()
	if (!tag) return null
	const hit = peekRaw('tag', tag)
	if (!hit || (hit.username ?? '') !== tag) return null
	return hit
}

export function rememberBeamioTagBasicMetadata(meta: BeamioTagBasicMetadata): void {
	const addr = (meta.address || '').trim().toLowerCase()
	if (!addr || !ethers.isAddress(addr)) return
	// the exact name as the server returned it (case kept; rule #1)
	const tag = (meta.username || '').trim().replace(/^@+/, '')
	const normAddr = ethers.getAddress(addr).toLowerCase()
	const payload: StoredEntry = {
		v: 1,
		savedAt: Date.now(),
		meta: {
			...meta,
			address: ethers.getAddress(addr),
			username: meta.username ?? '',
		},
	}
	const raw = JSON.stringify(payload)
	if (raw.length > MAX_ENTRY_JSON_CHARS) return

	const setOne = (kind: 'addr' | 'tag', keyVal: string) => {
		const k = indexKey(kind, keyVal)
		memory.set(k, payload.meta)
		if (typeof window === 'undefined') return
		try {
			localStorage.setItem(k, raw)
		} catch {
			/* quota */
		}
	}

	setOne('addr', normAddr)
	if (tag && tag !== 'unknow') {
		setOne('tag', tag)
	}
	trimOldestIfNeeded()
}

function trimOldestIfNeeded(): void {
	if (typeof window === 'undefined') return
	try {
		const keys: { k: string; savedAt: number }[] = []
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i)
			if (!k || !k.startsWith(PREFIX)) continue
			const raw = localStorage.getItem(k)
			if (!raw) continue
			try {
				const p = JSON.parse(raw) as StoredEntry
				if (p?.v === 1 && typeof p.savedAt === 'number') keys.push({ k, savedAt: p.savedAt })
			} catch {
				/* ignore */
			}
		}
		if (keys.length <= MAX_INDEX_ENTRIES_SOFT) return
		keys.sort((a, b) => a.savedAt - b.savedAt)
		const drop = keys.length - MAX_INDEX_ENTRIES_SOFT
		for (let i = 0; i < drop; i++) {
			const fullKey = keys[i]!.k
			localStorage.removeItem(fullKey)
			const rest = fullKey.slice(PREFIX.length)
			const colon = rest.indexOf(':')
			if (colon === -1) continue
			memory.delete(fullKey)
		}
	} catch {
		/* ignore */
	}
}
