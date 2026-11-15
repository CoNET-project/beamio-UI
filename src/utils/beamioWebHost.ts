/**
 * The Beamio web host check: exact host-name equality only. No suffix match, no wildcard, no regular expression on the host.
 * The old domain is not here: it lives in its own revertible compatibility commit.
 */
export const isBeamioWebHostname = (hostname: string): boolean => {
	const h = hostname.toLowerCase()
	return h === 'beamio.ca' || h === 'www.beamio.ca'
}

/** Text without a scheme (for example "beamio.ca/app/..."): the host part before the first path, query or fragment separator. */
export const beamioWebHostPrefixOf = (text: string): boolean => {
	const head = text.split(/[/?#]/)[0].toLowerCase()
	return head === 'beamio.ca' || head === 'www.beamio.ca'
}

/** An IPFS fragment image URL: the IPFS gateway host, or the Beamio fragment path on the Beamio web host. */
export const isIpfsOrBeamioFragmentUrl = (src: string): boolean => {
	try {
		const u = new URL(src)
		const h = u.hostname.toLowerCase()
		if (h === 'ipfs.conet.network') return true
		return isBeamioWebHostname(h) && u.pathname === '/api/fragment'
	} catch {
		return false
	}
}
