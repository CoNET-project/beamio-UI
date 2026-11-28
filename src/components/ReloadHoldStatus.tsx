/**
 * a standing status line while a reload is held, WHOEVER asked for it (the application itself, a button, the service worker). Before this the explanation existed only for a
 * button tap (a toast), so an application-requested reload that was held for minutes showed the user nothing. It follows the hold (chatWriteLock.onReloadHoldChange) and a 1 s clock for the tiers (30 s, 4 min).
 * It lets nothing through: it only shows what is going on (the rule of the hold is unchanged). Production code: it is not behind the hook switch.
 */
import { useEffect, useState } from 'react'
import { tu } from '../locale/beamioLocale'
import { onReloadHoldChange, reloadHoldView } from '../services/chatWriteLock'
import { reloadHoldStatusOf } from '../services/reloadHeldNotice'

export default function ReloadHoldStatus() {
	const [, setTick] = useState(0)
	useEffect(() => onReloadHoldChange(() => setTick((t) => t + 1)), [])
	const status = reloadHoldStatusOf(reloadHoldView())
	// the tiers change with time: the clock runs only while a hold is shown
	const showing = status !== null
	useEffect(() => {
		if (!showing) return
		const id = window.setInterval(() => setTick((t) => t + 1), 1000)
		return () => window.clearInterval(id)
	}, [showing])
	if (!status) return null
	return (
		<div role="status" aria-live="polite" data-testid="reload-hold-status" data-key={status.key} className="pointer-events-none fixed left-1/2 top-3 z-[999] w-[92%] max-w-md -translate-x-1/2 rounded-xl border border-white/15 bg-[#071126] px-3 py-2 text-xs leading-5 text-white shadow-lg">
			{tu(status.key, { count: status.count })}
		</div>
	)
}
