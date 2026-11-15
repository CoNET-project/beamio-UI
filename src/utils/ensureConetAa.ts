import { ethers } from 'ethers'
import { CONET_RPC_URL } from '@/config/chainAddresses'
import { beamioApi } from '@/utils/constants'
import { resolveBeamioAaOnConet } from '@/utils/resolveBeamioAaFromCardFactory'
import { CoNET_Data, setCoNET_Data } from '@/utils/globals'
import { flushStoreSystemData } from '@/services/beamio'
import { abortAfter, BOOT_REQUEST_TIMEOUT_MS, withBootTimeout } from '@/utils/bootTimeout'

const conetProvider = new ethers.JsonRpcProvider(CONET_RPC_URL)
const conetEnsureInFlight = new Map<string, Promise<string | null>>()

async function fetchEnsureConetAaFromApi(eoa: string): Promise<string | null> {
	// the in-flight entry below is shared, so a stalled request must end (a failed call after the bound, never a hang).
	const timeout = abortAfter(BOOT_REQUEST_TIMEOUT_MS)
	try {
		const res = await fetch(`${beamioApi}/api/ensureAAForEOAOnConet?eoa=${encodeURIComponent(eoa)}`, { signal: timeout.signal })
		if (!res.ok) return null
		const data = await res.json().catch(() => ({}))
		const aa = typeof data?.aa === 'string' ? data.aa.trim() : ''
		return aa && ethers.isAddress(aa) ? ethers.getAddress(aa) : null
	} catch {
		return null
	} finally {
		timeout.done()
	}
}

/** 在 CoNET 上检测 AA；无则经 API 创建。失败返回 null（保留上次 profile，不当作「无 AA」覆写）。 */
export async function ensureConetAaForEoa(eoa: string): Promise<string | null> {
	const norm = ethers.getAddress(eoa)
	const key = norm.toLowerCase()
	const inflight = conetEnsureInFlight.get(key)
	if (inflight) return inflight

	const task = (async (): Promise<string | null> => {
		// an RPC that never answers is the same as an RPC error here (the API path below), after the bound.
		const existing = await withBootTimeout(resolveBeamioAaOnConet(conetProvider, norm).catch(() => null), BOOT_REQUEST_TIMEOUT_MS, null)
		if (existing) return existing

		const created = await fetchEnsureConetAaFromApi(norm)
		if (!created) return null

		const code = await withBootTimeout(conetProvider.getCode(created).catch(() => '0x'), BOOT_REQUEST_TIMEOUT_MS, '0x')
		if (!code || code === '0x') return null
		return created
	})()

	conetEnsureInFlight.set(key, task)
	try {
		return await task
	} finally {
		conetEnsureInFlight.delete(key)
	}
}

/** 确保 CoNET AA 并将 aaAccount 写入 profile + IndexedDB（仅可信成功时）。 */
export async function ensureConetAaForProfileAndPersist(
	profile: profile | null | undefined,
	setProfiles?: (next: profile[]) => void
): Promise<string | null> {
	const eoa = profile?.keyID?.trim()
	if (!eoa || !ethers.isAddress(eoa)) return null

	const aa = await ensureConetAaForEoa(eoa)
	if (!aa || aa.toLowerCase() === eoa.toLowerCase()) return null

	const temp = CoNET_Data
	if (!temp?.profiles?.length) return aa

	const current = temp.profiles[0].aaAccount?.toLowerCase() ?? ''
	if (current === aa.toLowerCase()) return aa

	const nextProfiles = temp.profiles.map((p, i) =>
		i === 0 ? { ...p, aaAccount: aa } : p
	)
	temp.profiles = nextProfiles
	setCoNET_Data(temp)
	setProfiles?.(nextProfiles)
	// Immediate PouchDB write — debounced storeSystemData can lose aaAccount on refresh.
	await flushStoreSystemData()
	return aa
}
