import { Image } from 'expo-image'
import React from 'react'
import { View } from 'react-native'

const artwork = {
	playing: require('./assets/mascot/playing.png'),
	video: require('./assets/mascot/video.png'),
	loading: require('./assets/mascot/loading.png'),
	empty: require('./assets/mascot/empty.png'),
	search: require('./assets/mascot/search.png'),
	error: require('./assets/mascot/error.png'),
	liked: require('./assets/mascot/liked.png'),
	sleep: require('./assets/mascot/sleep.png'),
} as const

export type MascotState = keyof typeof artwork

/** Decorative only: adjacent text and controls always explain the real state. */
export function MascotArt({ state, size = 140 }: { state: MascotState; size?: number }) {
	return (
		<View testID={`mascot-${state}`} pointerEvents='none' accessible={false} accessibilityElementsHidden importantForAccessibility='no-hide-descendants' style={{ width: size, height: size, maxWidth: '100%', alignSelf: 'center' }}>
			<Image source={artwork[state]} contentFit='contain' transition={0} accessible={false} style={{ width: '100%', height: '100%' }} />
		</View>
	)
}
