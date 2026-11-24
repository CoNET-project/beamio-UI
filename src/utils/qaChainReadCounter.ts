/**
 * QA-build-only: counts the page's own requests to the public chain RPC per minute (requests, failures, the top JSON-RPC method names) and
 * logs one "[net]" line a minute while there is any. Integers and method names (eth_*) only. In every other build the install returns at once.
 * It only observes: the request goes on unchanged.
 */
import { qaLine } from './qaLog'

let installed = false
const METHOD = /^(eth|net|web3)_[A-Za-z]{1,40}$/

export function installQaChainReadCounter(
	scope: { fetch: typeof fetch; setInterval: typeof setInterval } = window,
	emit: (line: string) => void = (l) => qaLine('[net]', l),
	tag = 'main',
): void {
	if (process.env.REACT_APP_QA_BRIDGE_COUNTER !== 'true' || installed || !scope || typeof scope.fetch !== 'function') return
	installed = true
	const original = scope.fetch.bind(scope)
	let req = 0
	let fail = 0
	let methods: Record<string, number> = {}
	let dup = 0
	const seen = new Map<string, number>()
	scope.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
		const isRpc = url.includes('publicrpc')
		if (isRpc) {
			req += 1
			try {
				// the body of an ethers request is bytes, not a string
				const raw = init?.body
				const text = typeof raw === 'string' ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw instanceof ArrayBuffer ? new TextDecoder().decode(new Uint8Array(raw)) : ''
				const call = text && text.length < 20_000 ? (JSON.parse(text) as { method?: unknown; params?: unknown }) : null
				const method = call && typeof call.method === 'string' && METHOD.test(call.method) ? call.method : 'other'
				let key = method
				if (call && method === 'eth_call' && Array.isArray(call.params) && call.params[0] && typeof call.params[0] === 'object') {
					// contract address prefix and function selector only (public values; never the call data)
					const tx = call.params[0] as { to?: unknown; data?: unknown; input?: unknown }
					const to = typeof tx.to === 'string' && /^0x[0-9a-fA-F]{40}$/.test(tx.to) ? tx.to.slice(0, 10).toLowerCase() : 'none'
					const d = typeof tx.data === 'string' ? tx.data : typeof tx.input === 'string' ? tx.input : ''
					const sel = /^0x[0-9a-fA-F]{8}/.test(d) ? d.slice(0, 10).toLowerCase() : 'none'
					key = `eth_call/${to}/${sel}`
				}
				methods[key] = (methods[key] ?? 0) + 1
				// an identical request (same method and params, the id aside) within 2 s of the last one is a duplicate
				const same = call ? `${method}|${JSON.stringify(call.params ?? null).slice(0, 400)}` : ''
				const nowMs = Date.now()
				if (same) {
					const last = seen.get(same)
					if (last !== undefined && nowMs - last < 2_000) dup += 1
					seen.set(same, nowMs)
					if (seen.size > 600) seen.delete(seen.keys().next().value as string)
				}
			} catch {
				// observation only
			}
		}
		try {
			const res = await original(input as RequestInfo, init)
			if (isRpc && !res.ok) fail += 1
			return res
		} catch (e) {
			if (isRpc) fail += 1
			throw e
		}
	}) as typeof fetch
	scope.setInterval(() => {
		if (req === 0) return
		const ranked = Object.entries(methods).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`)
		const top = ranked.slice(0, 2).join(',')
		const next = ranked.slice(2, 5).join(',')
		const rest = ranked.slice(5, 8).join(',')
		emit(`chainread ${tag} req=${req} fail=${fail} dup=${dup} keys=${ranked.length} top=${top}`)
		if (next) emit(`chainread ${tag} more=${next}`.slice(0, 140))
		if (rest) emit(`chainread ${tag} more2=${rest}`.slice(0, 140))
		req = 0
		fail = 0
		dup = 0
		methods = {}
	}, 60_000)
}
