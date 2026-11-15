/**
 * Global BeamioTag mailbox mirror.
 * Local record first. Network supplements tag/image/names, listen online, and
 * native-shell wakeability when that field is older than 180 seconds.
 * Queries are encrypted to mailbox B and posted only through an entry C ≠ B.
 * An open chat thread claims online and refreshes that peer's online + nativeWakeable every 6 seconds.
 *
 * Network rules (2026-11-11 airplane test: one batch sent about 25 failing
 * probes in 1.5 s and used up the native entry probe budget):
 * - offline: no batch; wait for the `online` event, then start after a random
 *   3–15 s delay;
 * - three probes in a row with no trusted reply: stop the batch and keep the
 *   cursor, so the next batch starts at the same contact;
 * - at least 300 ms between contacts that send a probe.
 */

import { ethers } from 'ethers'
import { refreshChatMailboxPresence, refreshPeerNativeWakeable } from '@/services/chat'
import {
	getBeamioTagMirrorMap,
	mergeBeamioTagTrusted,
	searchBeamioTagRemote,
} from '@/services/beamioTagWorkerBridge'
import type { BeamioAddressProfileRecord } from '@/utils/beamioAddressProfileRegistry'
import { isShellContext } from './shellContext'
import { probeHasSigner } from './mailboxProbeSigning'
import { browserNetworkSource, recoveryJitterMs, type NetworkSource } from './chatNetworkGate'

export const BEAMIO_TAG_RECORD_FRESH_MS = 180_000

const MAX_PER_TICK = 28
/** Failed probes in a row that end a batch (network gone or entry service refusing). */
export const BEAMIO_TAG_FAILS_TO_STOP = 3
/** Minimum gap between contacts that send a probe. */
export const BEAMIO_TAG_CONTACT_GAP_MS = 300
const RECOVERY_MIN_MS = 3_000
const RECOVERY_MAX_MS = 15_000
const chatOwnedOnline = new Set<string>()

export function claimChatOnlineQuery(address: string): void {
	const key = address.trim().toLowerCase()
	if (key) chatOwnedOnline.add(key)
}

export function releaseChatOnlineQuery(address: string): void {
	chatOwnedOnline.delete(address.trim().toLowerCase())
}

function addrKey(address: string): string | null {
	const t = address.trim()
	if (!t || !ethers.isAddress(t)) return null
	try {
		return ethers.getAddress(t).toLowerCase()
	} catch {
		return null
	}
}

async function writeRecord(
	addressLower: string,
	patch: Partial<BeamioAddressProfileRecord>,
): Promise<void> {
	const prev = getBeamioTagMirrorMap()[addressLower]
	const next: BeamioAddressProfileRecord = {
		...prev,
		...patch,
		addressLower,
		updatedAt: patch.updatedAt ?? prev?.updatedAt ?? Date.now(),
	}
	await mergeBeamioTagTrusted({ [addressLower]: next })
}

export async function rememberPeerOnline(address: string, online: boolean): Promise<void> {
	const key = addrKey(address)
	if (!key) return
	await writeRecord(key, { online, onlineAt: Date.now() })
}

export async function rememberPeerNativeWakeable(
	address: string,
	nativeWakeable: boolean,
): Promise<void> {
	const key = addrKey(address)
	if (!key) return
	await writeRecord(key, { nativeWakeable, nativeWakeAt: Date.now() })
}

type ChatRow = {
	address?: string
	chatData?: { routersArmoreds?: string }
}

type ProfileSnap = {
	privateKeyArmor?: string
	chats?: ChatRow[]
}

export type BeamioTagRefreshOptions = {
	net?: NetworkSource
	random?: () => number
	sleep?: (ms: number) => Promise<void>
	now?: () => number
}

export function startBeamioTagMailboxRefresh(
	getProfile: () => ProfileSnap | undefined,
	opts: BeamioTagRefreshOptions = {},
): () => void {
	const net = opts.net ?? browserNetworkSource
	const random = opts.random ?? Math.random
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
	const now = opts.now ?? Date.now
	let stopped = false
	let timer: ReturnType<typeof setTimeout> | undefined
	let cursor = 0
	let running = false

	const schedule = (delay: number) => {
		if (stopped) return
		if (timer !== undefined) clearTimeout(timer)
		timer = setTimeout(() => {
			timer = undefined
			void tick()
		}, delay)
	}

	const tick = async () => {
		if (stopped) return
		if (running) {
			schedule(BEAMIO_TAG_RECORD_FRESH_MS)
			return
		}
		// Offline: no timer; the online listener starts the next batch.
		if (!net.isOnline()) return
		running = true
		let pausedForNetwork = false
		try {
			const profile = getProfile()
			const key = (profile?.privateKeyArmor || '').trim()
			const chats = profile && Array.isArray(profile.chats) ? profile.chats : []
			const startedAt = now()
			const batchStart = cursor < chats.length ? cursor : 0
			const batch = chats.slice(batchStart, batchStart + MAX_PER_TICK)
			cursor = batchStart + MAX_PER_TICK >= chats.length ? 0 : batchStart + MAX_PER_TICK
			let failsInRow = 0
			let probedBefore = false
			for (let i = 0; i < batch.length; i++) {
				if (stopped) return
				const chat = batch[i]
				if (!net.isOnline() || failsInRow >= BEAMIO_TAG_FAILS_TO_STOP) {
					// Resume at this contact next time.
					cursor = batchStart + i
					pausedForNetwork = true
					break
				}
				const addr = addrKey(chat.address || '')
				const route = chat.chatData?.routersArmoreds?.trim() || ''
				if (!addr) continue
				const rec = getBeamioTagMirrorMap()[addr]
				const needTag = !rec?.updatedAt || startedAt - rec.updatedAt > BEAMIO_TAG_RECORD_FRESH_MS
				// (a), in a shell the probe needs no page key (it goes through mailboxProbeSign).
				const shell = isShellContext()
				const signable = probeHasSigner(shell, key)
				const needOnline = signable && !!route && !chatOwnedOnline.has(addr) &&
					(!rec?.onlineAt || startedAt - rec.onlineAt > BEAMIO_TAG_RECORD_FRESH_MS)
				const needWake = signable && !!route &&
					(!rec?.nativeWakeAt || startedAt - rec.nativeWakeAt > BEAMIO_TAG_RECORD_FRESH_MS)
				// Nothing stale for this contact: no request, no gap.
				if (!needTag && !needOnline && !needWake) continue
				if (probedBefore) await sleep(BEAMIO_TAG_CONTACT_GAP_MS)
				if (stopped) return
				probedBefore = true
				if (needTag) {
					try {
						await searchBeamioTagRemote(ethers.getAddress(addr))
					} catch {
						/* keep the last tag and image */
					}
				}
				if (!signable || !route) continue
				let probed = false
				let gotReply = false
				const fresh = getBeamioTagMirrorMap()[addr]
				if (
					!chatOwnedOnline.has(addr) &&
					(!fresh?.onlineAt || startedAt - fresh.onlineAt > BEAMIO_TAG_RECORD_FRESH_MS)
				) {
					probed = true
					const onlineByAddr = await refreshChatMailboxPresence(
						[{ address: addr, chatData: { routersArmoreds: route } } as never],
						key,
					)
					if (onlineByAddr.has(addr)) {
						gotReply = true
						await rememberPeerOnline(addr, !!onlineByAddr.get(addr))
					}
				}
				const afterOnline = getBeamioTagMirrorMap()[addr]
				if (!afterOnline?.nativeWakeAt || startedAt - afterOnline.nativeWakeAt > BEAMIO_TAG_RECORD_FRESH_MS) {
					probed = true
					const wake = await refreshPeerNativeWakeable(addr, route, key)
					if (wake?.ok) {
						gotReply = true
						await rememberPeerNativeWakeable(addr, wake.nativeWakeable)
					}
				}
				if (probed) failsInRow = gotReply ? 0 : failsInRow + 1
			}
			if (!pausedForNetwork && failsInRow >= BEAMIO_TAG_FAILS_TO_STOP) {
				// The last contacts of the batch all failed: treat like a pause too.
				pausedForNetwork = true
			}
		} finally {
			running = false
			if (!stopped && pausedForNetwork) {
				console.info('[BeamioTag] mailbox refresh paused: no network or no replies')
			}
			// Offline: wait for the online event. Otherwise the normal 180 s pace.
			if (net.isOnline()) schedule(BEAMIO_TAG_RECORD_FRESH_MS)
		}
	}

	const unsubscribe = net.onOnline(() => {
		if (stopped) return
		schedule(recoveryJitterMs(RECOVERY_MIN_MS, RECOVERY_MAX_MS, random))
	})

	void tick()
	return () => {
		stopped = true
		if (timer !== undefined) clearTimeout(timer)
		unsubscribe()
	}
}
