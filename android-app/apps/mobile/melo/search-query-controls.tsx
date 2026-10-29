import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
	Pressable,
	StyleSheet,
	TextInput,
	View,
	useWindowDimensions,
} from 'react-native'

import {
	resolveThemeControlRow,
	type ThemeControlRowPolicy,
} from './core/theme-layout'
import { Icon, T, shape, useTheme, useThemeRendering } from './ui'

export interface SearchQueryControlsProps {
	query: string
	placeholder: string
	onQueryChange: (value: string) => void
	onSubmit: (value?: string) => void | Promise<void>
}

/** One stable native input row. The host measures slots, never the input text. */
export function SearchQueryControls(props: SearchQueryControlsProps) {
	const policy = useThemeRendering()?.controlRowLayout ?? null
	return policy ? (
		<MeasuredQueryControls
			{...props}
			policy={policy}
		/>
	) : (
		<QueryRow {...props} />
	)
}

function QueryRow({
	query,
	placeholder,
	onQueryChange,
	onSubmit,
}: SearchQueryControlsProps) {
	const theme = useTheme(),
		c = theme.tokens
	return (
		<View
			style={[
				s.row,
				{ borderRadius: 11 },
				{
					backgroundColor: c.surface.card,
					borderColor: c.border.subtle,
					borderWidth: 1,
					paddingLeft: 13,
				},
			]}
		>
			<Icon
				name='search' themed={false}
				color={c.text.secondary}
				size={19}
			/>
			<TextInput
				testID='search-input'
				accessibilityLabel='搜索关键词或 BV 号'
				value={query}
				onChangeText={onQueryChange}
				onSubmitEditing={(event) => {
					const value = event.nativeEvent.text
					onQueryChange(value)
					void onSubmit(value)
				}}
				returnKeyType='search'
				autoCapitalize='none'
				autoCorrect={false}
				placeholder={placeholder}
				placeholderTextColor={c.text.secondary}
				selectionColor={c.action.primary}
				cursorColor={c.action.primary}
				style={{
					flex: 1,
					minHeight: 48,
					color: c.text.primary,
					paddingHorizontal: 10,
					fontSize: 14,
				}}
			/>
			<Pressable
				accessibilityRole='button'
				accessibilityLabel='提交搜索'
				onPress={() => {
					void onSubmit()
				}}
				style={{
					minWidth: 58,
					minHeight: 48,
					alignItems: 'center',
					justifyContent: 'center',
				}}
			>
				<T
					style={{ color: c.action.primary }}
					weight='600'
				>
					搜索
				</T>
			</Pressable>
		</View>
	)
}

function MeasuredQueryControls({
	query,
	placeholder,
	onQueryChange,
	onSubmit,
	policy,
}: SearchQueryControlsProps & { policy: ThemeControlRowPolicy }) {
	const theme = useTheme(),
		c = theme.tokens,
		viewport = useWindowDimensions()
	// A keyboard height change cannot remove the input or invalidate its width.
	const key = JSON.stringify([viewport.width, viewport.fontScale])
	const [previous, setIdentity] = useState(() => ({
		key,
		policy,
		generation: 0,
	}))
	let identity = previous
	if (previous.key !== key || previous.policy !== policy) {
		identity = { key, policy, generation: previous.generation + 1 }
		setIdentity(identity)
	}
	const [measurement, setMeasurement] = useState<{
		identity: object
		width: number
		revision: number
	} | null>(null)
	const latestMeasurement = useRef<typeof measurement>(null)
	const width = measurement?.identity === identity ? measurement.width : 0
	const round = useMemo(
		() => ({ identity, measurement }),
		[identity, measurement],
	)
	const active = useRef<typeof round | null>(null)
	const enabled = useRef(false)
	const [slots, setSlots] = useState<{
		round: object
		input?: number
		submit?: number
	} | null>(null)
	const resolution = useMemo(
		() =>
			width > 19
				? resolveThemeControlRow(policy, {
						availableWidthDp: width - 19,
						// Input minimum includes its original 20dp horizontal padding; text scrolls.
						controlMinWidthsDp: [48, 58],
						gapDp: 0,
					})
				: null,
		[policy, width],
	)
	const fit = resolution && resolution.kind !== 'rejected' ? resolution : null
	const ready =
		!!fit &&
		slots?.round === round &&
		(slots.input ?? 0) >= fit.minWidthsDp[0] &&
		(slots.submit ?? 0) >= fit.minWidthsDp[1]
	useLayoutEffect(() => {
		active.current = round
		return () => {
			if (active.current === round) active.current = null
		}
	}, [round])
	useLayoutEffect(() => {
		// Native invalidation can revoke permission between commits, including an
		// invalid -> valid batch whose final ready value is unchanged.
		enabled.current = ready
		return () => {
			enabled.current = false
		}
	})
	const record = (slot: 'input' | 'submit', next: number) => {
		if (active.current !== round) return
		const value = Number.isFinite(next) && next > 0 ? next : 0
		if (!fit || value < fit.minWidthsDp[slot === 'input' ? 0 : 1])
			enabled.current = false
		setSlots((old) => ({
			...(old?.round === round ? old : { round }),
			[slot]: value,
		}))
	}
	const marker = `${identity.generation}:${measurement?.identity === identity ? measurement.revision : 0}`
	return (
		<View
			style={[
				shape(theme.components.input),
				{
					backgroundColor: c.surface.card,
					borderColor: c.border.subtle,
					borderWidth: 1,
					paddingLeft: 13,
				},
			]}
		>
			<View
				key={marker}
				testID='search-query-width'
				accessible={false}
				pointerEvents='none'
				style={{ alignSelf: 'stretch', height: 0 }}
				onLayout={({ nativeEvent }) => {
					if (active.current !== round) return
					const next = nativeEvent.layout.width
					const value = Number.isFinite(next) && next > 0 ? next : 0
					const last = latestMeasurement.current
					if (last?.identity === identity && last.width === value) return
					enabled.current = false
					const measured = {
						identity,
						width: value,
						revision: last?.identity === identity ? last.revision + 1 : 1,
					}
					// Keep every observed change even if batched A -> B -> A has the
					// same final width. Only fresh markers can supply this round's slots.
					latestMeasurement.current = measured
					setMeasurement(measured)
				}}
			/>
			<View style={s.row}>
				<Icon
					name='search' themed={false}
					color={c.text.secondary}
					size={19}
				/>
				<View style={{ flex: 1, minWidth: 0 }}>
					<View
						key={marker}
						testID='search-query-input-width'
						accessible={false}
						pointerEvents='none'
						style={{ alignSelf: 'stretch', height: 0 }}
						onLayout={({ nativeEvent }) =>
							record('input', nativeEvent.layout.width)
						}
					/>
					<TextInput
						testID='search-input'
						accessibilityLabel='搜索关键词或 BV 号'
						value={query}
						onChangeText={onQueryChange}
						editable={ready}
						accessibilityState={{ disabled: !ready }}
						onSubmitEditing={(event) => {
							if (active.current !== round || !enabled.current) return
							const value = event.nativeEvent.text
							onQueryChange(value)
							void onSubmit(value)
						}}
						returnKeyType='search'
						autoCapitalize='none'
						autoCorrect={false}
						placeholder={placeholder}
						placeholderTextColor={c.text.secondary}
						selectionColor={c.action.primary}
						cursorColor={c.action.primary}
						style={{
							width: '100%',
							minHeight: Math.max(50, fit?.touchDp ?? policy.minTouchDp),
							color: c.text.primary,
							paddingHorizontal: 10,
							fontSize: 14,
						}}
					/>
				</View>
				<View
					style={{
						width: fit?.minWidthsDp[1] ?? 58,
						flexShrink: 1,
						maxWidth: '100%',
					}}
				>
					<View
						key={marker}
						testID='search-query-submit-width'
						accessible={false}
						pointerEvents='none'
						style={{ alignSelf: 'stretch', height: 0 }}
						onLayout={({ nativeEvent }) =>
							record('submit', nativeEvent.layout.width)
						}
					/>
					<Pressable
						accessibilityRole='button'
						accessibilityLabel='提交搜索'
						disabled={!ready}
						accessibilityState={{ disabled: !ready }}
						onPress={() => {
							if (active.current === round && enabled.current) void onSubmit()
						}}
						style={{
							width: '100%',
							minHeight: fit?.touchDp ?? policy.minTouchDp,
							alignItems: 'center',
							justifyContent: 'center',
						}}
					>
						<T
							style={{ color: c.action.primary }}
							weight='600'
						>
							搜索
						</T>
					</Pressable>
				</View>
			</View>
			{((width > 0 && width <= 19) ||
				resolution?.kind === 'rejected' ||
				(fit &&
					slots?.round === round &&
					slots.input !== undefined &&
					slots.submit !== undefined &&
					!ready)) && (
				<T style={{ color: c.state.error }}>
					主题搜索栏暂不适合当前宽度，请使用兼容主题。
				</T>
			)}
		</View>
	)
}

const s = StyleSheet.create({
	row: { flexDirection: 'row', alignItems: 'center' },
})
