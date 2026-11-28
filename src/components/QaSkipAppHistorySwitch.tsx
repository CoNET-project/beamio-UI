/**
 * (hook variant only): the on-screen switch "跳过 App 层历史还原" (utils/qaSkipAppHistory.ts). Mounted ONLY in the hook variant (index.tsx: `QA_ACK_ORDER_HOOK && ...`). Default OFF; it takes effect
 * from the next history batch and stays after a reload (localStorage). It shows only its own state; no text, key or id.
 */
import { useState } from 'react'
import { qaSkipAppHistoryOn, setQaSkipAppHistory } from '../utils/qaSkipAppHistory'

export default function QaSkipAppHistorySwitch() {
	const [on, setOn] = useState(() => qaSkipAppHistoryOn())
	return (
		<div data-testid="qa-skip-app-history" data-on={on ? '1' : '0'} style={{ position: 'fixed', left: 6, bottom: 130, zIndex: 100000, display: 'flex', gap: 4, alignItems: 'center', padding: '3px 6px', borderRadius: 10, background: 'rgba(0,0,0,0.65)', color: '#fff', fontSize: 11 }}>
			<span>跳过 App 层历史还原</span>
			<button
				type="button"
				data-testid="qa-skip-app-history-toggle"
				aria-pressed={on}
				onClick={() => {
					const next = !on
					setQaSkipAppHistory(next)
					setOn(next)
				}}
				style={{ padding: '2px 6px', borderRadius: 8, border: '1px solid #fff', background: on ? '#c33' : 'transparent', color: '#fff', fontSize: 11 }}
			>
				{on ? '开' : '关'}
			</button>
		</div>
	)
}
