/**
 * the on-screen switch of the "模拟传输故障" (services/qaTransportFault.ts). Mounted ONLY in the hook variant (index.tsx: `QA_ACK_ORDER_HOOK && ...`), so it does not exist in a production bundle.
 * A small fixed pill; tapping a button sets the mode of THIS page's own sends. It carries no text of any message and no account data.
 */
import { useEffect, useState } from 'react'
import { onQaFaultChange, qaFaultHits, qaFaultMode, setQaFaultMode, type QaFaultMode } from '../services/qaTransportFault'

const MODES: Array<{ mode: QaFaultMode; label: string }> = [
	{ mode: 'off', label: '关' },
	{ mode: 'network_error', label: '网络错误' },
	{ mode: 'timeout', label: '超时' },
]

export default function QaTransportFaultSwitch() {
	const [, setTick] = useState(0)
	useEffect(() => onQaFaultChange(() => setTick((t) => t + 1)), [])
	// the hit counter changes without a mode change: a slow refresh keeps the number honest
	useEffect(() => {
		const id = window.setInterval(() => setTick((t) => t + 1), 1000)
		return () => window.clearInterval(id)
	}, [])
	const current = qaFaultMode()
	return (
		<div data-testid="qa-transport-fault" data-mode={current} style={{ position: 'fixed', left: 6, bottom: 70, zIndex: 100000, display: 'flex', gap: 4, alignItems: 'center', padding: '3px 6px', borderRadius: 12, background: 'rgba(0,0,0,0.65)', color: '#fff', fontSize: 11 }}>
			<span>模拟传输故障</span>
			{MODES.map((m) => (
				<button key={m.mode} type="button" data-testid={`qa-fault-${m.mode}`} aria-pressed={current === m.mode} onClick={() => setQaFaultMode(m.mode)} style={{ padding: '2px 6px', borderRadius: 8, border: '1px solid #fff', background: current === m.mode ? '#d9534f' : 'transparent', color: '#fff', fontSize: 11 }}>
					{m.label}
				</button>
			))}
			<span data-testid="qa-fault-hits">{qaFaultHits()}</span>
		</div>
	)
}
