/**
 * The account effects that write to CoNET or to the chain once an account is entered (approach a′): the AA ensure
 * (GET /api/ensureAAForEOAOnConet, a server-side write) and the stashed referrer / share-referee binds (contract writes).
 *
 * A key-only account (entered without a local mnemonic, see the key-only branch of App's init) makes none of these calls. The
 * `keyOnlyEntered` flag is checked by every effect below; a mnemonic account keeps the previous behaviour. Moved here from App
 * unchanged apart from the flag, so the rule can be tested with the real effect logic (see useAccountBindEffects.test.tsx).
 */
import { useEffect } from 'react'
import { ethers } from 'ethers'
import { ensureConetAaForProfileAndPersist } from '@/utils/ensureConetAa'
import { bindStashedShareRefereesIfNeeded } from '@/utils/discoverShareClickEvent'
import { DISCOVER_SHARE_REFERRER_STASHED_EVENT } from '@/utils/discoverShareReferrerStash'
import { AGENT_INVITE_INTRODUCER_STASHED_EVENT } from '@/utils/agentInviteIntroducerStash'
import { bindStashedAgentInviteReferrerIfNeeded } from '@/utils/agentInviteReferrerBind'
import { resolveSigningPrivateKeyArmor } from '@/utils/resolveSigningPrivateKeyArmor'

type SetProfiles = Parameters<typeof ensureConetAaForProfileAndPersist>[1]
/** The account's profile; the mnemonic field is read by the key-only route (the profile type does not declare it). */
type AccountProfile = profile & { mnemonicPhrase?: string }

export function useAccountBindEffects(opts: {
	isInitialLoading: boolean
	profiles: AccountProfile[] | undefined
	setProfiles: SetProfiles
	/** True when the account was entered as key-only (no local mnemonic). Then no AA ensure and no bind runs. */
	keyOnlyEntered: boolean
}): void {
	const { isInitialLoading, profiles, setProfiles, keyOnlyEntered } = opts

	/** 钱包解锁后静默 ensure CoNET AA（任意路由；深链 /discover 不再仅限 Home `/`）。 */
	useEffect(() => {
		if (isInitialLoading || keyOnlyEntered) return
		const profile = profiles?.[0]
		const eoa = profile?.keyID?.trim()
		if (!eoa || !ethers.isAddress(eoa)) return
		const persistedAa = profile?.aaAccount?.trim()
		if (
			persistedAa &&
			ethers.isAddress(persistedAa) &&
			persistedAa.toLowerCase() !== eoa.toLowerCase()
		) {
			return
		}
		void ensureConetAaForProfileAndPersist(profile, setProfiles)
	}, [isInitialLoading, keyOnlyEntered, profiles?.[0]?.keyID, profiles?.[0]?.aaAccount, setProfiles])

	/** Agent invite `invite=0x` → offline RegisterReferrer under introducer. */
	useEffect(() => {
		if (isInitialLoading || keyOnlyEntered) return
		const profile = profiles?.[0]
		const eoa = profile?.keyID?.trim()
		if (!eoa || !ethers.isAddress(eoa)) return
		// Wait until signing material exists (or bind's brief retry); keep stash otherwise.
		if (!resolveSigningPrivateKeyArmor(profile)) return
		void bindStashedAgentInviteReferrerIfNeeded(eoa)
	}, [
		isInitialLoading,
		keyOnlyEntered,
		profiles?.[0]?.keyID,
		profiles?.[0]?.privateKeyArmor,
		profiles?.[0]?.mnemonicPhrase,
	])

	useEffect(() => {
		if (typeof window === 'undefined') return
		const onStashed = () => {
			if (keyOnlyEntered) return
			const profile = profiles?.[0]
			const eoa = profile?.keyID?.trim()
			if (!eoa || !ethers.isAddress(eoa)) return
			if (!resolveSigningPrivateKeyArmor(profile)) return
			void bindStashedAgentInviteReferrerIfNeeded(eoa)
		}
		window.addEventListener(AGENT_INVITE_INTRODUCER_STASHED_EVENT, onStashed)
		return () => window.removeEventListener(AGENT_INVITE_INTRODUCER_STASHED_EVENT, onStashed)
	}, [keyOnlyEntered, profiles?.[0]?.keyID, profiles?.[0]?.privateKeyArmor, profiles?.[0]?.mnemonicPhrase])

	/** Share-link `ref=` binds need the opener's AA, which usually appears after the first open. */
	useEffect(() => {
		if (isInitialLoading || keyOnlyEntered) return
		const profile = profiles?.[0]
		const eoa = profile?.keyID?.trim()
		const aa = profile?.aaAccount?.trim()
		if (!eoa || !ethers.isAddress(eoa)) return
		if (!aa || !ethers.isAddress(aa) || aa.toLowerCase() === eoa.toLowerCase()) return
		const privateKeyArmor = resolveSigningPrivateKeyArmor(profile)
		if (!privateKeyArmor) return
		void bindStashedShareRefereesIfNeeded(privateKeyArmor)
	}, [isInitialLoading, keyOnlyEntered, profiles?.[0]?.keyID, profiles?.[0]?.aaAccount])

	useEffect(() => {
		if (isInitialLoading) return
		const retryBind = () => {
			if (keyOnlyEntered) return
			const profile = profiles?.[0]
			const eoa = profile?.keyID?.trim()
			const aa = profile?.aaAccount?.trim()
			if (!eoa || !ethers.isAddress(eoa)) return
			if (!aa || !ethers.isAddress(aa) || aa.toLowerCase() === eoa.toLowerCase()) return
			const privateKeyArmor = resolveSigningPrivateKeyArmor(profile)
			if (!privateKeyArmor) return
			void bindStashedShareRefereesIfNeeded(privateKeyArmor)
		}
		window.addEventListener(DISCOVER_SHARE_REFERRER_STASHED_EVENT, retryBind)
		return () => window.removeEventListener(DISCOVER_SHARE_REFERRER_STASHED_EVENT, retryBind)
	}, [isInitialLoading, keyOnlyEntered, profiles?.[0]?.keyID, profiles?.[0]?.aaAccount])
}
