/**
 * The CoNET node list read from the chain (the Guardian registry). Two readers use it: the chat start keeps the last good list when a read
 * fails, and the identity-only init reads fresh only : a cached list is never sent to the init.
 */
import { GuardianNodesMainnet } from '@/utils/constants'

export type NodeListOutcome = { ok: true; nodes: nodeInfo[] } | { ok: false }

/** A read that succeeded (possibly with zero nodes) or failed (timeout, RPC error). */
export const loadCoNETNodesOutcome = async (): Promise<{ ok: true; nodes: nodeInfo[] } | { ok: false }> => {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const _nodes = await Promise.race([
			(async () => {
				const [_nodes1, _nodes2] = await Promise.all([
					GuardianNodesMainnet.getAllNodes(0, 400),
					GuardianNodesMainnet.getAllNodes(400, 800),
				])
				return [..._nodes1, ..._nodes2]
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('getAllNodes timeout')), 15_000)
			}),
		])
		const Guardian_Nodes: nodeInfo[] = []
		for (let i = 0; i < _nodes.length; i++) {
			const node = _nodes[i]
			const id = parseInt(node[0].toString())
			const pgpString: string = Buffer.from(node[1], 'base64').toString()
			const domain: string = node[2]
			const ipAddr: string = node[3]
			const region: string = node[4]
			Guardian_Nodes.push({
				ip_addr: ipAddr,
				armoredPublicKey: pgpString,
				domain,
				nftNumber: id,
				region,
			})
		}
		return { ok: true, nodes: Guardian_Nodes }
	} catch {
		return { ok: false }
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}


/**
 * The node list for the identity-only init: a fresh read only. An unavailable read and an empty list both return [], and the init then
 * omits the `nodes` key (the native layer keeps its stored nodes). A non-empty list is returned as it is.
 */
export const readNodeListForInit = async (): Promise<nodeInfo[]> => {
	const outcome = await loadCoNETNodesOutcome()
	return outcome.ok ? outcome.nodes : []
}
