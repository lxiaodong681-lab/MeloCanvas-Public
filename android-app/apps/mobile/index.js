import { registerOrpheusHeadlessTask } from '@bbplayer/orpheus'
import { registerRootComponent } from 'expo'

import App from './melo/account-root'

// The account gate owns startup; native playback also rejects unauthenticated commands.
registerOrpheusHeadlessTask(async () => {})
registerRootComponent(App)
