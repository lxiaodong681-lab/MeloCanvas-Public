import React from 'react'
import { StyleSheet, View } from 'react-native'

import { T } from './ui'

export function PageTitle({
	title,
	subtitle,
}: {
	title: string
	subtitle?: string
}) {
	return (
		<View style={{ marginBottom: 18 }}>
			{subtitle ? (
				<T
					size={9}
					muted
					style={s.eyebrow}
				>
					{subtitle}
				</T>
			) : null}
			<T
				variant='title'
				weight='700'
				style={{ marginTop: subtitle ? 5 : 0 }}
			>
				{title}
			</T>
		</View>
	)
}
const s = StyleSheet.create({
	eyebrow: { letterSpacing: 1.5 },
})
