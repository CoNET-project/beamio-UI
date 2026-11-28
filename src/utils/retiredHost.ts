/**
 * One web host is blocked: nothing may be requested from it, whatever data names it. A media or API address on it is either
 * rewritten to the current address of the same content or refused. ONLY that domain (and its subdomains) is touched; every other address is passed on unchanged.
 *
 * The host appears ONCE, in the rule below, for recognising such addresses. The build check (scripts/check-retired-domain.js) allows exactly this rule text, counts it and reports it.
 */
const RULE = 'blocked-host=beamio.app'
const HOST = RULE.slice(RULE.indexOf('=') + 1)
const CURRENT_FRAGMENT = 'https://beamio.ca/api/fragment?hash='

const parse = (raw: string): URL | null => {
	try { return new URL(raw.trim(), 'https://relative.invalid/') } catch { return null }
}

/** true for the blocked host and its subdomains, in any spelling the URL parser reads as that host (case, trailing dot, user-info, encoded letters, a protocol-relative form) */
export function isRetiredHostUrl(raw: unknown): boolean {
	if (typeof raw !== 'string' && !(typeof URL !== 'undefined' && raw instanceof URL)) return false
	const url = parse(String(raw))
	if (!url) return false
	const host = url.hostname.toLowerCase().replace(/\.+$/, '')
	return host === HOST || host.endsWith(`.${HOST}`)
}

/** `raw` unchanged unless it is on the blocked host; then the current address of the same fragment, or '' (refused) when the address names no fragment */
export function safeResourceUrl(raw: string): string {
	if (!isRetiredHostUrl(raw)) return raw
	const url = parse(raw)!
	const hash = (url.searchParams.get('hash') ?? '').replace(/^0x/i, '')
	return url.pathname === '/api/fragment' && /^[0-9a-f]{64}$/i.test(hash) ? `${CURRENT_FRAGMENT}0x${hash.toLowerCase()}` : ''
}

/** a srcset with any candidate on the blocked host is refused as a whole */
export const srcsetNamesRetiredHost = (value: string): boolean => value.split(/[\s,]+/).some((part) => part.includes('//') && isRetiredHostUrl(part))
