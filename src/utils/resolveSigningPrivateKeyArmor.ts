import { ensureProfilePrivateKeyArmorFromMnemonic } from '@/services/beamio'
import { CoNET_Data, setCoNET_Data } from '@/utils/globals'
import { shellChatBlockedNow } from '@/services/shellChatCapability'

type ProfileWithKey = { privateKeyArmor?: string | null } | null | undefined

/**
 * Signing material for open-claim / EIP-712 flows.
 * Prefer in-memory profile; then `CoNET_Data` (IndexedDB + mnemonic hydrate).
 * Consumer apps may persist `privateKeyArmor` locally — see `beamio-consumer-wallet-signing-storage.mdc`.
 */
export function resolveSigningPrivateKeyArmor(profile?: ProfileWithKey): string {
	// Option A: a shell without the chat capability holds no page key for signing.
	if (shellChatBlockedNow()) return ''
	const fromProfile = profile?.privateKeyArmor?.trim() ?? ''
	if (fromProfile) return fromProfile
	const hydrated = ensureProfilePrivateKeyArmorFromMnemonic(CoNET_Data)
	if (hydrated && hydrated !== CoNET_Data) {
		setCoNET_Data(hydrated)
	}
	return hydrated?.profiles?.[0]?.privateKeyArmor?.trim() ?? ''
}
