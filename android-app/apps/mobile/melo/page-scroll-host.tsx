import React from 'react'
import { ScrollView, View, type ScrollViewProps } from 'react-native'

/** A virtualized page owns the sole vertical scroll host; other routes are unchanged. */
export function PageScrollHost({
	virtualized,
	scrollRef,
	children,
	style,
	...props
}: ScrollViewProps & {
	virtualized: boolean
	scrollRef: React.RefObject<ScrollView | null>
}) {
	return virtualized ? (
		<View
			testID={props.testID}
			style={[{ flex: 1 }, style]}
		>
			{children}
		</View>
	) : (
		<ScrollView
			{...props}
			ref={scrollRef}
			style={style}
		>
			{children}
		</ScrollView>
	)
}
