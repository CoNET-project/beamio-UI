/**
 * Which runtime is this page in: a confirmed browser, a trusted native shell, or not known. One build serves all of them, so this is decided at run time. NOT WIRED yet: nothing in the product calls this.
 *
 * The anchor is the page's own origin, which a script of the page cannot change. The presence of an object on `window` proves nothing and never makes a shell.
 *  - browser: the origin is one that serves the official web app, the path is the app's, the page is the top frame, and nothing looks like a native bridge.
 *  - shell: the origin is an embedded shell origin AND the native side answered this page's hello, echoing its fresh random value.
 *  - unknown: everything else. A shell origin never becomes a browser. Unknown can later only become that same shell (a valid late answer), never a browser.
 * The decision is made once and then does not change, whatever is added to or removed from the page afterwards.
 *
 * What this does not do: a page cannot prove by script alone that the other end is native. The trust rests on the origin given by the platform and on the native side accepting and answering only the main frame of
 * its embedded origin. Script that runs inside a shell origin is outside what this protects against.
 */

/** the one official web entry (https://beamio.ca/app/). Other host names that serve the same files are NOT trusted by that fact. */
export const OFFICIAL_WEB_ORIGINS: readonly string[] = ['https://beamio.ca']
export const SHELL_ORIGINS: Readonly<Record<string, 'ios' | 'android'>> = { 'cashtrees-local://localhost': 'ios', 'https://appassets.androidplatform.net': 'android' }
export const SHELL_HELLO = 'beamioShellHello'
export const SHELL_HELLO_ACK = 'beamioShellHelloAck'
/** one try. The start-up decision uses one try, so it ends within the agreed 5 s total. */
export const DEFAULT_HELLO_TIMEOUT_MS = 3_000

export interface RuntimeFacts {
	href: string
	isTopFrame: boolean
	/** does anything on the page look like a native bridge (any of the objects the app talks to) */
	bridgeLookalike: boolean
}
export type UnknownReason = 'bad_location' | 'framed' | 'origin_not_listed' | 'path_outside_app' | 'bridge_on_web_origin' | 'hello_timeout' | 'hello_failed' | 'not_decided'
export interface ShellHello { type: typeof SHELL_HELLO; v: 1; nonce: string }
export type RuntimeVerdict =
	| { kind: 'browser' }
	| { kind: 'shell'; platform: 'ios' | 'android'; appBuild: string; capabilities: readonly string[] }
	| { kind: 'unknown'; reason: UnknownReason }

export interface OriginPolicy {
	webOrigins: readonly string[]
	/** paths a web origin serves the app under */
	webPathPrefix: string
}
/** local loopback origins for testing are NOT listed (to be decided by review) */
export const DEFAULT_ORIGIN_POLICY: OriginPolicy = { webOrigins: OFFICIAL_WEB_ORIGINS, webPathPrefix: '/app' }

export function classifyOrigin(facts: RuntimeFacts, policy: OriginPolicy = DEFAULT_ORIGIN_POLICY): { kind: 'browser' } | { kind: 'shell_candidate'; platform: 'ios' | 'android' } | { kind: 'unknown'; reason: UnknownReason } {
	let url: URL
	try { url = new URL(facts.href) } catch { return { kind: 'unknown', reason: 'bad_location' } }
	// scheme and host only: blob:, data:, file: and the like inherit nothing here; a user-info part never counts
	if (url.username || url.password) return { kind: 'unknown', reason: 'bad_location' }
	const origin = `${url.protocol}//${url.host}`
	if (!facts.isTopFrame) return { kind: 'unknown', reason: 'framed' }
	if (Object.prototype.hasOwnProperty.call(SHELL_ORIGINS, origin)) return { kind: 'shell_candidate', platform: SHELL_ORIGINS[origin]! }
	if (!policy.webOrigins.includes(origin)) return { kind: 'unknown', reason: 'origin_not_listed' }
	if (!(url.pathname === policy.webPathPrefix || url.pathname.startsWith(`${policy.webPathPrefix}/`))) return { kind: 'unknown', reason: 'path_outside_app' }
	return facts.bridgeLookalike ? { kind: 'unknown', reason: 'bridge_on_web_origin' } : { kind: 'browser' }
}

/** the exact shape of an answer to THIS hello; anything else is null */
export function readHelloAck(message: unknown, nonce: string, platform: 'ios' | 'android'): Extract<RuntimeVerdict, { kind: 'shell' }> | null {
	const m = message as { type?: unknown; v?: unknown; nonce?: unknown; platform?: unknown; appBuild?: unknown; capabilities?: unknown } | null
	if (!m || typeof m !== 'object' || m.type !== SHELL_HELLO_ACK || m.v !== 1) return null
	if (typeof m.nonce !== 'string' || m.nonce !== nonce || m.platform !== platform) return null
	if (typeof m.appBuild !== 'string' || !m.appBuild.trim()) return null
	if (!Array.isArray(m.capabilities) || !m.capabilities.every((c): c is string => typeof c === 'string')) return null
	return { kind: 'shell', platform, appBuild: m.appBuild, capabilities: Object.freeze([...m.capabilities]) }
}

export const newHelloNonce = (): string => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')

export interface RuntimeArbiter {
	/** the verdict as it stands: 'not_decided' until resolve() has finished */
	current(): RuntimeVerdict
	/** decides once (single flight). An unknown shell candidate may be asked again with retry(). */
	resolve(): Promise<RuntimeVerdict>
	/** only for an unknown shell candidate: a new hello with a new random value. Browser and shell never change. */
	retry(): Promise<RuntimeVerdict>
}

export function createRuntimeArbiter(input: {
	/** read once, here */
	facts: RuntimeFacts
	/** sends the hello over the native transport; `onAck` may be called later (or never) */
	sendHello: (hello: ShellHello, onAck: (message: unknown) => void) => void
	policy?: OriginPolicy
	timeoutMs?: number
	nonce?: () => string
	setTimer?: (fn: () => void, ms: number) => unknown
}): RuntimeArbiter {
	const origin = classifyOrigin({ ...input.facts }, input.policy)
	const setTimer = input.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
	let verdict: RuntimeVerdict = { kind: 'unknown', reason: 'not_decided' }
	let running: Promise<RuntimeVerdict> | null = null
	const ask = (platform: 'ios' | 'android'): Promise<RuntimeVerdict> => new Promise((done) => {
		const nonce = (input.nonce ?? newHelloNonce)()
		let settled = false
		const settle = (v: RuntimeVerdict) => { if (!settled) { settled = true; done(v) } }
		const onAck = (message: unknown) => {
			if (verdict.kind === 'shell') return
			const shell = readHelloAck(message, nonce, platform)
			if (!shell) return // a wrong answer decides nothing; the timeout stands
			verdict = shell // also when it is late: unknown may become this shell, never anything else
			settle(shell)
		}
		const fail = (reason: UnknownReason) => { if (verdict.kind !== 'shell') verdict = { kind: 'unknown', reason }; settle(verdict) }
		setTimer(() => { if (!settled) fail('hello_timeout') }, input.timeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS)
		try { input.sendHello({ type: SHELL_HELLO, v: 1, nonce }, onAck) } catch { fail('hello_failed') }
	})
	const decide = (): Promise<RuntimeVerdict> => {
		if (origin.kind === 'shell_candidate') return ask(origin.platform)
		verdict = origin.kind === 'browser' ? { kind: 'browser' } : { kind: 'unknown', reason: origin.reason }
		return Promise.resolve(verdict)
	}
	return {
		current: () => verdict,
		resolve: () => (running ??= decide()),
		retry: () => {
			if (origin.kind !== 'shell_candidate' || verdict.kind !== 'unknown' || verdict.reason === 'not_decided') return running ?? Promise.resolve(verdict)
			running = ask(origin.platform)
			return running
		},
	}
}

/**
 * The two native entries of the hello (names agreed with the native side; native accepts and answers only the main frame of its embedded origin).
 *  iOS:     window.webkit.messageHandlers.beamioShellHello.postMessage(hello) returns a promise of the answer (a reply handler; a refusal rejects).
 *  Android: window.__beamioShellHello (a web message listener limited to the embedded origin): postMessage(JSON text), the answer arrives at onmessage as event.data (JSON text). Where the platform lacks the feature
 *           nothing is registered.
 * The object is taken once, when the transport is made; a missing entry throws (unknown, 'hello_failed'). The old SDK hello is not used: it cannot tell which frame called.
 */
export function shellHelloTransport(platform: 'ios' | 'android', page: unknown): (hello: ShellHello, onAck: (message: unknown) => void) => void {
	const w = page as { webkit?: { messageHandlers?: { beamioShellHello?: { postMessage?: (m: unknown) => unknown } } }; __beamioShellHello?: { postMessage?: (m: string) => void; onmessage?: ((e: { data?: unknown }) => void) | null } } | undefined
	if (platform === 'ios') {
		const handler = w?.webkit?.messageHandlers?.beamioShellHello
		const post = handler?.postMessage
		return (hello, onAck) => {
			if (!handler || typeof post !== 'function') throw new Error('no_hello_entry')
			const reply = post.call(handler, hello) as { then?: unknown } | undefined
			// only a promise can carry the answer; a rejection (refused by native) is left to the timeout
			if (!reply || typeof reply.then !== 'function') throw new Error('no_hello_reply')
			void (reply as Promise<unknown>).then(onAck, () => undefined)
		}
	}
	const channel = w?.__beamioShellHello
	const post = channel?.postMessage
	return (hello, onAck) => {
		if (!channel || typeof post !== 'function') throw new Error('no_hello_entry')
		channel.onmessage = (event) => {
			let message: unknown = null
			try { message = typeof event?.data === 'string' ? JSON.parse(event.data) : null } catch { message = null }
			onAck(message)
		}
		post.call(channel, JSON.stringify(hello))
	}
}

export class PageKeyRefused extends Error {
	constructor(public readonly because: RuntimeVerdict) { super('page_key_refused') }
}
/** THE guard of every path that holds or reads this account's private keys in page code (the former build-time boundary points). Default deny: only a confirmed browser passes. */
export function assertPageKeyAllowed(arbiter: Pick<RuntimeArbiter, 'current'> | null | undefined): void {
	const v: RuntimeVerdict = arbiter ? arbiter.current() : { kind: 'unknown', reason: 'not_decided' }
	if (v.kind !== 'browser') throw new PageKeyRefused(v)
}
/** creating, restoring, writing or removing wallet records in the page store: only in a confirmed browser or a trusted shell (which uses its own native paths); never while unknown */
export const mayWriteWalletRecords = (v: RuntimeVerdict): boolean => v.kind === 'browser' || v.kind === 'shell'
