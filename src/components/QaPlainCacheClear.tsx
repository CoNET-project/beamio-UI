/**
 * the on-screen control of the plaintext-cache control round. Mounted ONLY in the hook variant (index.tsx: `QA_ACK_ORDER_HOOK && ...`), so it does not exist in any other build.
 * One button: "清空明文缓存" deletes the plaintext history-cache keys of THIS account from the worker's IndexedDB (utils/qaPlainCache.ts qaClearPlainCache: key range `beamio.chat.history.plain:<eoa>:` only; the library and the account record
 * are not touched) and shows the numbers before and after. Reload the page after it to see where the first copy comes from without the plaintext cache. No text, no key, no id is shown.
 */
import { useState } from 'react'
import { qaEvent } from '../utils/qaAckOrder'
import { qaClearPlainCacheForOwner } from '../utils/qaPlainCache'

export default function QaPlainCacheClear() {
	const [label, setLabel] = useState('')
	return (
		<div data-testid="qa-plain-cache-clear" style={{ position: 'fixed', left: 6, bottom: 100, zIndex: 100000, display: 'flex', gap: 4, alignItems: 'center', padding: '3px 6px', borderRadius: 10, background: 'rgba(0,0,0,0.65)', color: '#fff', fontSize: 11 }}>
			<button
				type="button"
				data-testid="qa-plain-cache-clear-button"
				onClick={() => {
					void qaClearPlainCacheForOwner((n, d) => qaEvent(n, undefined, d)).then((r) => setLabel(r.ok ? `前${r.before} 后${r.after}` : `失败:${r.reason}`))
				}}
				style={{ padding: '2px 6px', borderRadius: 8, border: '1px solid #fff', background: 'transparent', color: '#fff', fontSize: 11 }}
			>
				清空明文缓存
			</button>
			<span data-testid="qa-plain-cache-clear-result">{label}</span>
		</div>
	)
}
