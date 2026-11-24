/**
 * The update prompt of an old shell (opened by a tap on the chat call button). The links are opened only by the user's tap, through the
 * existing external-link bridge. The wording is a locale key; the links are the fixed official consumer channels.
 */
import { tu } from '../locale/beamioLocale'
import { openExternalUrl, getCashTreesNativeNfcHost } from '../utils/cashTreesNativeNfc'
import { upgradeLinksFor } from '../services/callUpgradePrompt'

export default function CallUpgradeDialog({ onClose }: { onClose: () => void }) {
	const links = upgradeLinksFor(getCashTreesNativeNfcHost())
	return (
		<div role="dialog" aria-modal="true" data-testid="call-upgrade-dialog" className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 px-6">
			<div className="w-full max-w-sm rounded-2xl bg-white p-5 text-center shadow-xl">
				<p className="text-sm font-semibold text-slate-800">{tu('call.upgrade.chat')}</p>
				<div className="mt-4 flex flex-col gap-2">
					{links.map((l) => (
						<button
							key={l.id}
							type="button"
							data-testid={`call-upgrade-link-${l.id}`}
							onClick={() => openExternalUrl(l.url)}
							className="rounded-full bg-[#2f80ed] px-4 py-2.5 text-sm font-semibold text-white"
						>
							{tu(l.labelKey)}
						</button>
					))}
					<button type="button" data-testid="call-upgrade-close" onClick={onClose} className="rounded-full bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700">
						{tu('call.upgrade.close')}
					</button>
				</div>
			</div>
		</div>
	)
}
