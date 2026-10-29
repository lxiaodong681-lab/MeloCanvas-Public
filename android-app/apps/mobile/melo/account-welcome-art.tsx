import { Image } from 'expo-image'
import React from 'react'
import { View } from 'react-native'
import Svg, { Circle, Ellipse, G, Path, Rect } from 'react-native-svg'

import type { ThemeKey } from './core/theme'

export interface AccountWelcomeArtProps {
	themeKey: ThemeKey
	width: number
}

/** Original built-in art only; no account, storage, transport or interaction. */
export function AccountWelcomeArt({ themeKey, width }: AccountWelcomeArtProps) {
	const height = Math.max(180, Math.min(205, width * 0.64))
	return (
		<View
			testID={`account-welcome-art-${themeKey}`}
			pointerEvents='none'
			accessible={false}
			accessibilityElementsHidden
			importantForAccessibility='no-hide-descendants'
			style={{ width, height, alignSelf: 'center', overflow: 'hidden' }}
		>
			<View
				style={{
					position: 'absolute',
					width: 320,
					height: 204,
					left: (width - 320) / 2,
					top: (height - 204) / 2,
					transform: [{ scale: height / 204 }],
				}}
			>
				{themeKey === 'modern' ? (
					<ModernWelcomeArt />
				) : themeKey === 'pastoral' ? (
					<PastoralWelcomeArt />
				) : (
					<AnimeWelcomeArt />
				)}
			</View>
		</View>
	)
}

function ModernWelcomeArt() {
	return (
		<>
			<Svg
				width={320}
				height={204}
				viewBox='0 0 320 204'
			>
				<Ellipse
					cx={137}
					cy={181}
					rx={71}
					ry={9}
					fill='#292925'
					opacity={0.07}
				/>
				<G
					rotation={-12}
					origin='136,103'
				>
					<Circle
						cx={136}
						cy={103}
						r={78}
						fill='#272825'
					/>
					{Array.from({ length: 15 }, (_, index) => 75 - index * 3.5).map(
						(radius) => (
							<Circle
								key={radius}
								cx={136}
								cy={103}
								r={radius}
								fill='none'
								stroke='#42433e'
								strokeWidth={0.8}
							/>
						),
					)}
					<Path
						d='M71 91A67 67 0 0 1 121 38M82 95A56 56 0 0 1 123 48'
						stroke='#8b8c82'
						strokeWidth={0.8}
						opacity={0.16}
						fill='none'
					/>
					<Circle
						cx={136}
						cy={103}
						r={20}
						fill='#f9e9e3'
					/>
					<Circle
						cx={136}
						cy={103}
						r={5}
						fill='#cb483a'
					/>
				</G>
				<Circle
					cx={48}
					cy={168}
					r={3}
					fill='#cb483a'
				/>
			</Svg>
			<View
				style={{
					position: 'absolute',
					left: 132,
					top: 17,
					width: 133,
					height: 166,
					padding: 8,
					borderWidth: 1,
					borderColor: '#e9e5dd',
					borderRadius: 4,
					backgroundColor: '#fffdf9',
					transform: [{ rotate: '9deg' }],
					boxShadow: '0px 7px 17px #2929251b',
				}}
			>
				<Svg
					width={115}
					height={130}
					viewBox='0 0 115 130'
				>
					<Rect
						width={115}
						height={130}
						fill='#d7e0d7'
					/>
					<Circle
						cx={70.5}
						cy={35.5}
						r={17.5}
						fill='#f2d7af'
					/>
					<Rect
						y={69}
						width={115}
						height={61}
						fill='#73958f'
					/>
					<Path
						d='M-14 78C35 65 72 84 92 113L107 143H-14Z'
						fill='#e9dfc9'
						stroke='#f6eed8'
						strokeWidth={4}
					/>
				</Svg>
				<View style={{ flexDirection: 'row', gap: 3, paddingTop: 9 }}>
					<View style={{ width: 9, height: 2, backgroundColor: '#cb483a' }} />
					<View style={{ width: 26, height: 2, backgroundColor: '#e9e5dd' }} />
					<View style={{ width: 26, height: 2, backgroundColor: '#e9e5dd' }} />
				</View>
			</View>
		</>
	)
}

function PastoralWelcomeArt() {
	return (
		<>
			<Image
				source={require('./assets/botanical.svg')}
				contentFit='fill'
				accessible={false}
				style={{
					position: 'absolute',
					left: -17,
					top: -35,
					width: 354,
					height: 251,
					opacity: 0.75,
				}}
			/>
			<Svg
				width={320}
				height={204}
				viewBox='0 0 320 204'
			>
				<Circle
					cx={148}
					cy={102}
					r={84}
					fill='none'
					stroke='#a5b99b'
					opacity={0.4}
				/>
				<Circle
					cx={148}
					cy={102}
					r={72}
					fill='none'
					stroke='#a5b99b'
					opacity={0.27}
				/>
			</Svg>
			<View
				style={{
					position: 'absolute',
					left: 88,
					top: 11,
					width: 150,
					height: 178,
					borderTopLeftRadius: 75,
					borderTopRightRadius: 75,
					borderBottomLeftRadius: 16,
					borderBottomRightRadius: 16,
					backgroundColor: '#fffff5',
					transform: [{ rotate: '-3deg' }],
					boxShadow: '9px 12px 0px #dce3cc80, 0px 7px 18px #2e443717',
				}}
			>
				<Image
					source={require('./assets/meadow.svg')}
					contentFit='cover'
					accessible={false}
					style={{
						position: 'absolute',
						left: 6,
						top: 6,
						right: 6,
						bottom: 6,
						borderTopLeftRadius: 69,
						borderTopRightRadius: 69,
						borderBottomLeftRadius: 10,
						borderBottomRightRadius: 10,
					}}
				/>
			</View>
			<Svg
				width={320}
				height={204}
				viewBox='0 0 320 204'
				style={{ position: 'absolute' }}
			>
				<Path
					d='M232 182Q229 155 251 144Q258 165 232 182'
					fill='#52794f'
					rotation={14}
					origin='243,163'
				/>
				<Path
					d='M251 152Q248 136 263 128Q268 143 251 152'
					fill='#52794f'
					opacity={0.4}
					rotation={36}
					origin='258,140'
				/>
			</Svg>
		</>
	)
}

function AnimeWelcomeArt() {
	return (
		<>
			<Svg
				width={320}
				height={204}
				viewBox='0 0 320 204'
			>
				<G
					rotation={-23}
					origin='160,110'
					fill='none'
					stroke='#afa0d4'
				>
					<Ellipse
						cx={160}
						cy={110}
						rx={115}
						ry={45}
						opacity={0.4}
					/>
					<Ellipse
						cx={160}
						cy={110}
						rx={122}
						ry={37}
						opacity={0.2}
					/>
				</G>
			</Svg>
			<View
				style={{
					position: 'absolute',
					left: 85,
					top: 18,
					width: 155,
					height: 163,
					borderWidth: 1,
					borderColor: '#afa0d4',
					borderRadius: 6,
					backgroundColor: '#fffaff',
					transform: [{ rotate: '-8deg' }],
					boxShadow: '7px 7px 0px #d9d1ed',
				}}
			>
				<Image
					source={require('./assets/orbit.svg')}
					contentFit='cover'
					accessible={false}
					style={{
						position: 'absolute',
						left: 8,
						top: 8,
						right: 8,
						bottom: 18,
						borderRadius: 2,
					}}
				/>
				<View
					style={{
						position: 'absolute',
						left: 48,
						top: -8,
						width: 49,
						height: 16,
						backgroundColor: '#e8e2b9c9',
						transform: [{ rotate: '4deg' }],
					}}
				/>
			</View>
			<Svg
				width={320}
				height={204}
				viewBox='0 0 320 204'
				style={{ position: 'absolute' }}
			>
				<Path
					d='M264 23L267 32L277 36L267 40L264 49L260 40L251 36L260 32Z'
					fill='#7352ba'
					rotation={12}
					origin='264,36'
				/>
				<Path
					d='M57 151L59 156L64 158L59 160L57 166L55 160L50 158L55 156Z'
					fill='#b29b5d'
					rotation={-10}
					origin='57,158'
				/>
			</Svg>
		</>
	)
}
