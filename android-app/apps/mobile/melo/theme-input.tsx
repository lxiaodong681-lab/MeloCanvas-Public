import React, {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type Ref,
} from 'react'
import {
	StyleSheet,
	Text,
	TextInput,
	View,
	useWindowDimensions,
	type StyleProp,
	type TextInputProps,
	type ViewStyle,
} from 'react-native'

import { resolveThemeControlRow } from './core/theme-layout'
import {
	useThemeControlTarget,
	type ThemeControlRowStatus,
} from './theme-control-layout'
import { useTheme, useThemeRendering } from './ui'

export interface ThemeTextInputProps extends TextInputProps {
	ref?: Ref<TextInput>
	minimumWidthDp?: number
	minimumHeightDp?: number
	/** Responsive-only stable slot; horizontal parents must allocate its width. */
	containerStyle?: StyleProp<ViewStyle>
	layoutRevision?: string | number
	onStatusChange?: (status: ThemeControlRowStatus) => void
}

/** Native input stays mounted while its independent measurement slot changes. */
export function ThemeTextInput({
	ref,
	minimumWidthDp = 48,
	minimumHeightDp = 48,
	containerStyle,
	layoutRevision,
	onStatusChange,
	...props
}: ThemeTextInputProps) {
	const policy = useThemeRendering()?.controlRowLayout ?? null
	const theme = useTheme()
	// App appearance can differ from Android's system theme, including in modals.
	const themedProps = {
		...props,
		placeholderTextColor: props.placeholderTextColor ?? theme.tokens.text.secondary,
		selectionColor: props.selectionColor ?? theme.tokens.action.primary,
		cursorColor: props.cursorColor ?? theme.tokens.action.primary,
	}
	const inherited = useThemeControlTarget()
	const viewport = useWindowDimensions()
	const style = StyleSheet.flatten(props.style)
	const minWidth = Math.max(
		minimumWidthDp,
		typeof style?.minWidth === 'number' ? style.minWidth : 48,
		inherited?.minimumWidthDp ?? 48,
	)
	const minHeight = Math.max(
		minimumHeightDp,
		typeof style?.minHeight === 'number' ? style.minHeight : 48,
	)
	// Height-only keyboard changes do not alter the input's fitting width.
	const key = JSON.stringify([
		minimumWidthDp,
		minimumHeightDp,
		minWidth,
		inherited?.touchDp,
		layoutRevision,
		viewport.width,
		viewport.fontScale,
	])
	const [identity, setIdentity] = useState(() => ({
		key,
		policy,
		token: {},
		generation: 0,
	}))
	let currentIdentity = identity
	if (identity.key !== key || identity.policy !== policy) {
		currentIdentity = {
			key,
			policy,
			token: {},
			generation: identity.generation + 1,
		}
		setIdentity(currentIdentity)
	}
	const { token, generation } = currentIdentity
	const active = useRef<object | null>(null)
	const native = useRef<TextInput | null>(null)
	const initiallyAutoFocus = useRef(props.autoFocus === true)
	const autoFocused = useRef(false)
	const [measured, setMeasured] = useState<{
		token: object
		width: number
	} | null>(null)
	useLayoutEffect(() => {
		active.current = token
		return () => {
			if (active.current === token) active.current = null
		}
	}, [token])
	const status = useMemo<ThemeControlRowStatus>(() => {
		if (!policy) return { kind: 'pending' }
		if (measured?.token !== token || measured.width <= 0)
			return { kind: 'pending' }
		const resolution = resolveThemeControlRow(
			inherited
				? { minTouchDp: inherited.touchDp, narrowFallback: 'reject' }
				: policy,
			{
				availableWidthDp: measured.width,
				controlMinWidthsDp: [minWidth],
				gapDp: 0,
			},
		)
		return resolution.kind === 'rejected'
			? { kind: 'rejected', resolution }
			: { kind: 'ready', resolution }
	}, [policy, inherited, measured, token, minWidth])
	const lastReport = useRef<{
		receiver: NonNullable<ThemeTextInputProps['onStatusChange']>
		token: object
		value: string
	} | null>(null)
	useEffect(() => {
		if (active.current !== token) return
		if (!policy || !onStatusChange) {
			lastReport.current = null
			return
		}
		const value = JSON.stringify(status),
			previous = lastReport.current
		if (
			previous?.receiver !== onStatusChange ||
			previous.token !== token ||
			previous.value !== value
		) {
			lastReport.current = { receiver: onStatusChange, token, value }
			onStatusChange(status)
		}
	}, [policy, onStatusChange, status, token])
	const editable =
		props.editable !== false &&
		props.readOnly !== true &&
		status.kind === 'ready'
	const canSubmit = useRef(false)
	useLayoutEffect(() => {
		canSubmit.current = !!policy && editable
		return () => {
			canSubmit.current = false
		}
	}, [policy, editable, token])
	const bindRef = useCallback(
		(value: TextInput | null) => {
			native.current = value
			if (typeof ref === 'function') {
				const cleanup = ref(value)
				if (typeof cleanup === 'function')
					return () => {
						native.current = null
						cleanup()
					}
				return
			}
			if (ref) ref.current = value
		},
		[ref],
	)
	useLayoutEffect(() => {
		if (
			policy &&
			editable &&
			initiallyAutoFocus.current &&
			props.autoFocus &&
			!autoFocused.current &&
			native.current
		) {
			autoFocused.current = true
			native.current.focus()
		}
	}, [policy, editable, props.autoFocus])
	if (!policy)
		return ref === undefined ? (
			<TextInput {...themedProps} />
		) : (
			<TextInput
				{...themedProps}
				ref={ref}
			/>
		)
	const resolution = status.kind === 'ready' ? status.resolution : null
	return (
		<View style={[{ alignSelf: 'stretch' }, containerStyle]}>
			<View
				key={generation}
				accessible={false}
				pointerEvents='none'
				style={{ alignSelf: 'stretch', height: 0 }}
				onLayout={({ nativeEvent }) => {
					if (active.current !== token) return
					const width = nativeEvent.layout.width
					setMeasured({
						token,
						width: Number.isFinite(width) && width > 0 ? width : 0,
					})
				}}
			/>
			<TextInput
				{...themedProps}
				ref={bindRef}
				autoFocus={false}
				editable={editable}
				accessibilityState={{
					...props.accessibilityState,
					disabled: !editable || props.accessibilityState?.disabled,
				}}
				onSubmitEditing={(event) => {
					if (active.current === token && canSubmit.current)
						props.onSubmitEditing?.(event)
				}}
				style={[
					props.style,
					{
						alignSelf: 'stretch',
						width: '100%',
						maxWidth: '100%',
						minWidth: resolution?.minWidthsDp[0],
						minHeight: Math.max(
							minHeight,
							resolution?.touchDp ?? policy.minTouchDp,
						),
					},
				]}
			/>
			{status.kind === 'rejected' && (
				<Text
					accessibilityLiveRegion='polite'
					style={{ color: theme.tokens.state.error }}
				>
					主题输入框暂不适合当前宽度，请使用兼容主题。
				</Text>
			)}
		</View>
	)
}
