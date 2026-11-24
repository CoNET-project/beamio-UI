//	index.tsx

// Must stay the first import: takes a legacy Recovery Code out of the URL.
import './utils/legacyRestoreLinkBoot'
// WebSocket refusal (project rule): installed before any library that captures the global constructor is evaluated.
import { probeWebSocketRefusal } from './utils/webSocketGuard'
import './utils/ignoreResizeObserverLoopError'
import React from 'react';
import ReactDOM from 'react-dom/client';
import './locale/i18n';
import './index.css';
import App from './App';
import { BeamioLocaleRoot } from './locale/BeamioLocaleRoot';
import reportWebVitals from './reportWebVitals';
import { DaemonProvider } from './providers/DaemonProvider'
import { loadApiExcludedUserCards } from './utils/apiExcludedUserCards'
import { MerchantCardDatabaseProvider } from './providers/MerchantCardDatabaseProvider'
import { BeamioTagDatabaseProvider } from './providers/BeamioTagDatabaseProvider'
import { IpfsImageLibraryProvider } from './providers/IpfsImageLibraryProvider'
import { HashRouter as Router } from 'react-router-dom'
import { applyPendingConsumerDeepLinkIfNeeded } from './utils/pendingConsumerDeepLink'
import { installBeamioChatReceiver } from './utils/androidChatChannel'
import { installBeamioShellReceiver } from './utils/beamioShellChannel'
import { installInboundGenerationWatcher } from './services/inboundGeneration'
import { ensureRangTracking } from './utils/incomingRangTracking'
import { reportWebSocketProbe } from './utils/webSocketProbeReport'
import { publishNativePwaLog } from './utils/cashTreesNativePwaLog'
// Y.62 pgpUpgradeState: listen from startup so an event that arrives before the chat page mounts is recorded.
import { installPgpUpgradeStateListener } from './services/pgpUpgradeState';
import { installFirstIdentityStatusListener } from './services/firstIdentityStatus';
import { installQaChainReadCounter } from './utils/qaChainReadCounter';
installQaChainReadCounter();
// R81 item 8: the runtime refusal probe runs at boot (it opens no connection). R84: the result is kept on window.__beamioWsProbe and a failure goes to the native log; console is stripped in production.
reportWebSocketProbe(probeWebSocketRefusal(), (level, message) => publishNativePwaLog(level, message))
installPgpUpgradeStateListener();
installFirstIdentityStatusListener();
void loadApiExcludedUserCards()
// the Android shell's new chat channel (window.BeamioChat); top frame only, a no-op in a child frame or without it.
installBeamioChatReceiver()
installBeamioShellReceiver()
//1: the native inbound generation (init success and every advance) is kept from the start.
installInboundGenerationWatcher()
// the first sight of window.BeamioShell records when ring tracking starts; older calls are not asked.
ensureRangTracking()
applyPendingConsumerDeepLinkIfNeeded()

const root = ReactDOM.createRoot(
  	document.getElementById('root') as HTMLElement
)

root.render(
	<React.StrictMode>
		<Router>
			<DaemonProvider>
				<MerchantCardDatabaseProvider>
					<BeamioTagDatabaseProvider>
						<IpfsImageLibraryProvider>
							<BeamioLocaleRoot>
								<App />
							</BeamioLocaleRoot>
						</IpfsImageLibraryProvider>
					</BeamioTagDatabaseProvider>
				</MerchantCardDatabaseProvider>
			</DaemonProvider>
		</Router>
	</React.StrictMode>
)
// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals()

