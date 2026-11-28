/**
 * the on-screen switch of the "模拟远端提交失败" (services/qaRemoteFault.ts). Mounted ONLY in the hook variant (index.tsx: `process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && ...`), so it does not exist in a
 * production bundle. A small fixed pill; tapping a button sets the mode for THIS page's own inbound appends. It carries no message text and no account data.
 */
import { useEffect, useState } from 'react'
import { onQaRemoteFaultChange, qaRemoteFaultHits, qaRemoteFaultMode, setQaRemoteFaultMode, type QaRemoteFaultMode } from '../services/qaRemoteFault'

const MODES: Array<{ mode: QaRemoteFaultMode; label: string }> = [
	{ mode: 'off', label: '关' },
	{ mode: 'upload', label: '上传失败' },
	{ mode: 'pointer', label: '指针失败' },
	{ mode: 'timeout', label: '超时' },
]

export default function QaRemoteFaultSwitch() {
	const [, setTick] = useState(0)
	useEffect(() => onQaRemoteFaultChange(() => setTick((t) => t + 1)), [])
	useEffect(() => {
		const id = window.setInterval(() => setTick((t) => t + 1), 1000)
		return () => window.clearInterval(id)
	}, [])
	const current = qaRemoteFaultMode()
	return (
		<div data-testid="qa-remote-fault" data-mode={current} style={{ position: 'fixed', left: 6, bottom: 100, zIndex: 100000, display: 'flex', gap: 4, alignItems: 'center', padding: '3px 6px', borderRadius: 12, background: 'rgba(0,0,0,0.65)', color: '#fff', fontSize: 11 }}>
			<span>模拟远端提交失败</span>
			{MODES.map((m) => (
				<button key={m.mode} type="button" data-testid={`qa-remote-fault-${m.mode}`} aria-pressed={current === m.mode} onClick={() => setQaRemoteFaultMode(m.mode)} style={{ padding: '2px 6px', borderRadius: 8, border: '1px solid #fff', background: current === m.mode ? '#d9534f' : 'transparent', color: '#fff', fontSize: 11 }}>
					{m.label}
				</button>
			))}
			<span data-testid="qa-remote-fault-hits">{qaRemoteFaultHits()}</span>
		</div>
	)
}
