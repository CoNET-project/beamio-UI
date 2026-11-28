// Media and API addresses on the blocked host are rewritten or refused BEFORE any request; current addresses pass unchanged. jsdom with the network stubbed: no request leaves this test. SYNTHETIC addresses only.
import React from 'react'
import { render, renderHook, waitFor } from '@testing-library/react'
import { isRetiredHostUrl, safeResourceUrl, srcsetNamesRetiredHost } from './retiredHost'
import { installRetiredHostGuard } from './retiredHostGuard'
import { useIpfsMediaSrc } from '@/hooks/useIpfsMediaSrc'
import { resolveIpfsImageUrlToObjectUrl } from './ipfsImageLibrary'
import { resolveIpfsMediaUrlToObjectUrl } from './ipfsMediaLibrary'

const OLD = ['beamio', 'app'].join('.')
const HASH = 'ab'.repeat(32)
const OLD_MEDIA = `https://${OLD}/app/media/card.png`
const OLD_FRAGMENT = `https://www.${OLD}/api/fragment?hash=0x${HASH}`
const CURRENT = 'https://beamio.ca/app/media/card.png'
const OTHER = 'https://example.org/picture.png'
const NOW = `https://beamio.ca/api/fragment?hash=0x${HASH}`

const requests: string[] = []
const scope = window as unknown as Record<string, any>
beforeAll(() => {
	scope.fetch = (input: unknown) => { requests.push(String((input as { url?: string })?.url ?? input)); return Promise.reject(new Error('offline stub')) }
	;(globalThis as any).fetch = scope.fetch
	scope.XMLHttpRequest.prototype.open = function (_m: string, u: string) { requests.push(String(u)) }
	scope.navigator.sendBeacon = (u: string) => { requests.push(String(u)); return true }
	installRetiredHostGuard(scope)
	;(globalThis as any).fetch = scope.fetch
})
beforeEach(() => { requests.length = 0 })
const named = () => requests.filter((u) => u.toLowerCase().includes(OLD))

describe('the recognition', () => {
	it('every spelling the URL parser reads as that host or a subdomain', () => {
		for (const u of [OLD_MEDIA, `http://${OLD}`, `https://WWW.${OLD.toUpperCase()}/x`, `https://a.b.${OLD}./x`, `//${OLD}/x`, `https://user:pw@${OLD}:8443/x`, `https://${OLD.replace('.', '%2E')}/x`, `  ${OLD_MEDIA}  `]) expect([u, isRetiredHostUrl(u)]).toEqual([u, true])
	})
	it('only that domain: look-alikes, the current host, other hosts, relative and non-http addresses are not touched', () => {
		for (const u of [CURRENT, OTHER, `https://${OLD}.example.org/x`, `https://not${OLD}/x`, `https://beamio.ca/?next=${encodeURIComponent(OLD_MEDIA)}`, `https://${OLD}@example.org/x`, '/app/logo.png', 'data:image/png;base64,AAAA', 'blob:https://beamio.ca/1', 'ipfs://abc', 'com.beamio.application', '']) {
			expect([u, isRetiredHostUrl(u), safeResourceUrl(u)]).toEqual([u, false, u])
		}
	})
	it('a fragment address is rewritten to the current one; every other old address is refused', () => {
		expect(safeResourceUrl(OLD_FRAGMENT)).toBe(NOW)
		for (const u of [OLD_MEDIA, `https://${OLD}/api/fragment?hash=nothex`, `https://${OLD}/api/other?hash=0x${HASH}`]) expect(safeResourceUrl(u)).toBe('')
		expect(srcsetNamesRetiredHost(`${CURRENT} 1x, ${OLD_MEDIA} 2x`)).toBe(true)
		expect(srcsetNamesRetiredHost(`${CURRENT} 1x, ${OTHER} 2x`)).toBe(false)
	})
})

describe('the media paths named by the review', () => {
	it('the media hook never hands out an old address (first render and effect), and passes current ones through', async () => {
		const seen: string[] = []
		const r = renderHook(({ src }) => { const v = useIpfsMediaSrc(src); seen.push(v); return v }, { initialProps: { src: OLD_MEDIA } })
		await waitFor(() => expect(r.result.current).toBe(''))
		expect(seen.filter((v) => v.includes(OLD))).toEqual([])
		r.rerender({ src: CURRENT })
		await waitFor(() => expect(r.result.current).toBe(CURRENT))
	})
	it('an old fragment address: every attempt and every fallback is a current host', async () => {
		for (const resolve of [resolveIpfsImageUrlToObjectUrl, resolveIpfsMediaUrlToObjectUrl]) {
			requests.length = 0
			const out = await resolve(OLD_FRAGMENT)
			expect(out).toBe(NOW) // both sources fail in this offline stub: the fallback is the CURRENT address
			expect(named()).toEqual([])
			expect(requests.length).toBeGreaterThan(0)
			expect(requests.every((u) => /^https:\/\/(ipfs\.conet\.network|beamio\.ca)\//.test(u))).toBe(true)
		}
	}, 20_000)
	it('an old plain media address: refused, no request', async () => {
		for (const resolve of [resolveIpfsImageUrlToObjectUrl, resolveIpfsMediaUrlToObjectUrl]) expect(await resolve(OLD_MEDIA)).toBe('')
		expect(requests).toEqual([])
	})
	it('positive control: a current plain address is returned unchanged', async () => {
		expect(await resolveIpfsImageUrlToObjectUrl(CURRENT)).toBe(CURRENT)
		expect(await resolveIpfsMediaUrlToObjectUrl(OTHER)).toBe(OTHER)
	})
})

describe('every other place that renders an address from data (the browser entry points)', () => {
	it('React elements get no old address; fragment addresses are rewritten; current ones stay', () => {
		const { container } = render(
			<div>
				<img alt="a" src={OLD_MEDIA} />
				<img alt="b" src={OLD_FRAGMENT} />
				<img alt="c" src={CURRENT} srcSet={`${CURRENT} 1x, ${OLD_MEDIA} 2x`} />
				<video src={OLD_MEDIA} poster={OLD_MEDIA}><source src={OLD_MEDIA} /></video>
				<audio src={OLD_MEDIA} />
				<iframe title="f" src={OLD_MEDIA} />
				<svg><image href={OLD_MEDIA} /></svg>
				<a href={OLD_MEDIA}>a link is only followed when the user does so</a>
			</div>,
		)
		const resources = Array.from(container.querySelectorAll('img,video,audio,source,iframe,image'))
		const values = resources.flatMap((el) => Array.from(el.attributes).map((a) => a.value))
		expect(values.filter((v) => v.includes(OLD))).toEqual([])
		expect((container.querySelector('img[alt="a"]') as Element).hasAttribute('src')).toBe(false)
		expect((container.querySelector('img[alt="b"]') as Element).getAttribute('src')).toBe(NOW)
		expect((container.querySelector('img[alt="c"]') as Element).getAttribute('src')).toBe(CURRENT)
		expect((container.querySelector('img[alt="c"]') as Element).hasAttribute('srcset')).toBe(false)
		expect((container.querySelector('a') as Element).getAttribute('href')).toBe(OLD_MEDIA)
	})
	it('script-made elements and properties', () => {
		const img = new Image(); img.src = OLD_MEDIA
		const video = document.createElement('video'); video.poster = OLD_MEDIA; video.src = OLD_MEDIA
		const link = document.createElement('link'); link.href = OLD_MEDIA
		const script = document.createElement('script'); script.src = OLD_MEDIA
		for (const el of [img, video, link, script]) expect(el.outerHTML).not.toContain(OLD)
		img.src = OLD_FRAGMENT
		expect(img.getAttribute('src')).toBe(NOW)
		img.src = CURRENT
		expect(img.src).toBe(CURRENT)
	})
	it('fetch, XMLHttpRequest and sendBeacon: nothing reaches the transport for the blocked host; current addresses do', async () => {
		await expect(scope.fetch(`https://${OLD}/api/search-users?keyward=x`)).rejects.toThrow('retired_host_refused')
		await expect(scope.fetch({ url: OLD_FRAGMENT })).rejects.toThrow('retired_host_refused')
		expect(() => new scope.XMLHttpRequest().open('GET', OLD_MEDIA)).toThrow('retired_host_refused')
		expect(scope.navigator.sendBeacon(OLD_MEDIA)).toBe(false)
		expect(requests).toEqual([])
		await scope.fetch(OLD_FRAGMENT).catch(() => undefined)
		await scope.fetch(CURRENT).catch(() => undefined)
		new scope.XMLHttpRequest().open('GET', OTHER)
		scope.navigator.sendBeacon(CURRENT)
		expect(requests).toEqual([NOW, CURRENT, OTHER, CURRENT])
	})
	it('the page and the three workers install the guard first; the two style-text places call the rule', () => {
		const read = (p: string): string => require('fs').readFileSync(require('path').join(__dirname, '..', p), 'utf8')
		for (const f of ['index.tsx', 'workers/appDaemon/entry.ts', 'workers/beamioTag/entry.ts', 'workers/chatSdkGossip/entry.ts']) expect([f, read(f).includes('retiredHostGuardBoot')]).toEqual([f, true])
		for (const f of ['components/card/CardPassBackgroundImage.tsx', 'pages/Home/ActiveCouponsScreen.tsx']) { const t = read(f); expect(t).not.toMatch(/url\("\$\{(src|displaySrc)\}"\)/); expect(t).toContain('safeResourceUrl(') }
	})
})
