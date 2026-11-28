/**
 * The one place every page and worker request goes through for the blocked host (retiredHost.ts): the places that render an address taken from data are many, so the refusal sits at the browser's own entry points:
 * resource attributes and properties (images, video, audio, sources, frames, scripts, links), fetch, XMLHttpRequest and sendBeacon. Addresses on other hosts are passed on as they are.
 * Not covered here: addresses written into style text (the two places that build `url(...)` from data call safeResourceUrl themselves), HTML inserted as a string, and a navigation the user starts.
 */
import { isRetiredHostUrl, safeResourceUrl, srcsetNamesRetiredHost } from './retiredHost'

type Anyish = Record<string, any>
const INSTALLED = '__retiredHostGuard'
const RESOURCE_ELEMENTS = new Set(['img', 'video', 'audio', 'source', 'track', 'iframe', 'embed', 'object', 'script', 'link', 'input', 'image', 'use'])
const URL_ATTRIBUTES = new Set(['src', 'poster', 'data', 'href', 'xlink:href'])
const PROPERTIES: Array<[string, string]> = [
	['HTMLImageElement', 'src'], ['HTMLImageElement', 'srcset'], ['HTMLMediaElement', 'src'], ['HTMLSourceElement', 'src'], ['HTMLSourceElement', 'srcset'], ['HTMLVideoElement', 'poster'], ['HTMLTrackElement', 'src'],
	['HTMLIFrameElement', 'src'], ['HTMLEmbedElement', 'src'], ['HTMLObjectElement', 'data'], ['HTMLScriptElement', 'src'], ['HTMLLinkElement', 'href'], ['HTMLInputElement', 'src'],
]

const filtered = (name: string, value: unknown): { keep: boolean; value: unknown } => {
	if (typeof value !== 'string' && !(typeof URL !== 'undefined' && value instanceof URL)) return { keep: true, value }
	const text = String(value)
	if (name === 'srcset') return srcsetNamesRetiredHost(text) ? { keep: false, value: '' } : { keep: true, value }
	if (!isRetiredHostUrl(text)) return { keep: true, value }
	const safe = safeResourceUrl(text)
	return safe ? { keep: true, value: safe } : { keep: false, value: '' }
}

export function installRetiredHostGuard(scope: Anyish = globalThis as unknown as Anyish): void {
	if (scope[INSTALLED]) return
	scope[INSTALLED] = true

	const elementProto = scope.Element?.prototype
	if (elementProto) {
		for (const method of ['setAttribute', 'setAttributeNS'] as const) {
			const original = elementProto[method]
			if (typeof original !== 'function') continue
			elementProto[method] = function (this: Anyish, ...args: unknown[]) {
				const at = method === 'setAttribute' ? 0 : 1
				const name = String(args[at] ?? '').toLowerCase()
				const tag = String(this.localName ?? '').toLowerCase()
				if (RESOURCE_ELEMENTS.has(tag) && (URL_ATTRIBUTES.has(name) || name === 'srcset')) {
					const result = filtered(name, args[at + 1])
					// refused: the attribute is removed rather than set empty (an empty address is requested as the page itself)
					if (!result.keep) { this.removeAttribute(String(args[at]).replace(/^xlink:/, '')); return }
					args[at + 1] = result.value
				}
				return original.apply(this, args)
			}
		}
	}
	for (const [type, property] of PROPERTIES) {
		const proto = scope[type]?.prototype
		const descriptor = proto && Object.getOwnPropertyDescriptor(proto, property)
		if (!proto || !descriptor?.set) continue
		Object.defineProperty(proto, property, {
			...descriptor,
			set(this: Anyish, value: unknown) {
				const result = filtered(property, value)
				if (!result.keep) { this.removeAttribute(property); return }
				descriptor.set!.call(this, result.value)
			},
		})
	}
	const originalFetch = scope.fetch
	if (typeof originalFetch === 'function') {
		scope.fetch = function (this: unknown, input: unknown, init?: unknown) {
			const address = typeof input === 'string' || (typeof URL !== 'undefined' && input instanceof URL) ? String(input) : (input as { url?: unknown } | undefined)?.url
			if (typeof address === 'string' && isRetiredHostUrl(address)) {
				const safe = safeResourceUrl(address)
				// only a plain address is rewritten; a prepared Request for the old host is refused whole (its headers and body are not carried elsewhere)
				if (!safe || (typeof input !== 'string' && !(input instanceof URL))) return Promise.reject(new TypeError('retired_host_refused'))
				return originalFetch.call(scope, safe, init)
			}
			return originalFetch.call(scope, input, init)
		}
	}
	const xhrProto = scope.XMLHttpRequest?.prototype
	if (xhrProto && typeof xhrProto.open === 'function') {
		const open = xhrProto.open
		xhrProto.open = function (this: unknown, method: unknown, address: unknown, ...rest: unknown[]) {
			if (isRetiredHostUrl(String(address))) throw new TypeError('retired_host_refused')
			return open.call(this, method, address, ...rest)
		}
	}
	const navigatorLike = scope.navigator
	if (navigatorLike && typeof navigatorLike.sendBeacon === 'function') {
		const beacon = navigatorLike.sendBeacon.bind(navigatorLike)
		try { navigatorLike.sendBeacon = (address: unknown, data?: unknown) => (isRetiredHostUrl(String(address)) ? false : beacon(address, data)) } catch { /* read-only here: fetch and XHR stay guarded */ }
	}
}
