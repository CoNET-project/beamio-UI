/**
 * Business OS (Merchant OS) entry for a temp account (Chat SDK items A, B and F).
 *
 * The link never carries the passcode or any private key: it has the BeamioTag only. The temp account is unlocked with one
 * attempt (no polling). A failure opens nothing and is reported, so the caller can show the unified copy.
 */
export const MERCHANT_OS_AGENT_URL = 'https://biz.beamio.ca/biz/'

/** The Business OS link for a temp account. It takes no passcode and no key. */
export function merchantOsOpenUrl(beamioTag: string, flow?: 'business'): string {
	const params = new URLSearchParams({ tag: beamioTag.replace(/^@/, '').trim() })
	if (flow) params.set('flow', flow)
	return `${MERCHANT_OS_AGENT_URL}#/?${params.toString()}`
}

export type OpenMerchantOsResult = { ok: true } | { ok: false; reason: 'blocked' | 'unlock_failed' | 'open_failed' }

/**
 * Opens Business OS for a temp account after one unlock attempt. `blocked` is the shell check (option A): a blocked shell unlocks
 * nothing and opens nothing. The unlocked key is used only to decide whether to open; it is never put in the link.
 */
export async function openMerchantOsForTemp(input: {
	beamioTag: string
	flow?: 'business'
	blocked: boolean
	unlock: () => Promise<string | null>
	open: (url: string) => boolean
}): Promise<OpenMerchantOsResult> {
	if (input.blocked) return { ok: false, reason: 'blocked' }
	const key = await input.unlock()
	if (!key) return { ok: false, reason: 'unlock_failed' }
	const opened = input.open(merchantOsOpenUrl(input.beamioTag, input.flow))
	return opened ? { ok: true } : { ok: false, reason: 'open_failed' }
}
