import React, {
	createContext,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from 'react'
import {
	StyleSheet,
	Text,
	View,
	useWindowDimensions,
	type StyleProp,
	type ViewStyle,
} from 'react-native'

import {
	resolveThemeControlRow,
	resolveThemeNavigation,
	type ThemeControlRowPolicy,
	type ThemeControlRowResolution,
} from './core/theme-layout'

export interface ThemeControlTargetLayout {
	touchDp: number
	minimumWidthDp: number
	fill: boolean
	availableWidthDp: number
}

export type ThemeControlRowStatus =
	| { kind: 'pending' }
	| {
			kind: 'ready'
			resolution: Exclude<ThemeControlRowResolution, { kind: 'rejected' }>
	  }
	| {
			kind: 'rejected'
			resolution: Extract<ThemeControlRowResolution, { kind: 'rejected' }>
	  }

const Context = createContext<ThemeControlTargetLayout | null>(null)
export const useThemeControlTarget = () => useContext(Context)

export interface MeasuredThemeControlRowProps {
	policy: ThemeControlRowPolicy | null
	controlMinWidthsDp: readonly number[]
	children: ReactNode | ((target: ThemeControlTargetLayout) => ReactNode)
	style?: StyleProp<ViewStyle>
	navigation?: boolean
	gapDp?: number
	single?: boolean
	/** Callers may invalidate a container change before its next native onLayout. */
	layoutRevision?: string | number
	testID?: string
	errorColor?: string
	/** A report signal for a future preview/apply gate, never an activation decision. */
	onStatusChange?: (status: ThemeControlRowStatus) => void
	/** Hidden host probes must never announce their rejected placeholder. */
	announceStatus?: boolean
}

/** Measures the real container, never substitutes a screen width for its bounds. */
export function MeasuredThemeControlRow({
	policy,
	controlMinWidthsDp,
	children,
	style,
	navigation = false,
	gapDp: requestedGapDp,
	single = false,
	layoutRevision,
	testID,
	errorColor,
	onStatusChange,
	announceStatus = true,
}: MeasuredThemeControlRowProps) {
	const viewport = useWindowDimensions()
	const rowStyle = StyleSheet.flatten(style)
	const styledGap = rowStyle?.columnGap ?? rowStyle?.gap
	const gapDp = requestedGapDp ?? (typeof styledGap === 'number' ? styledGap : 0)
	// Viewport/font changes invalidate old measurements; these are NOT fit widths.
	const key = JSON.stringify([
		policy,
		controlMinWidthsDp,
		navigation,
		gapDp,
		single,
		layoutRevision,
		viewport.width,
		viewport.height,
		viewport.fontScale,
	])
	const [identity, setIdentity] = useState(() => ({
		key,
		policy,
		token: {},
		generation: 0,
	}))
	let { token, generation } = identity
	if (identity.key !== key || identity.policy !== policy) {
		const next = { key, policy, token: {}, generation: identity.generation + 1 }
		setIdentity(next)
		token = next.token
		generation = next.generation
	}
	const current = useRef<object | null>(null)
	const lastReport = useRef<{
		receiver: NonNullable<MeasuredThemeControlRowProps['onStatusChange']>
		token: object
		value: string
	} | null>(null)
	const [measured, setMeasured] = useState<{
		token: object
		width: number
	} | null>(null)
	useLayoutEffect(() => {
		current.current = token
		return () => {
			if (current.current === token) current.current = null
		}
	}, [token])
	const width = measured?.token === token ? measured.width : 0
	const status = useMemo<ThemeControlRowStatus>(() => {
		if (!policy || width <= 0) return { kind: 'pending' }
		const measurements = { availableWidthDp: width, controlMinWidthsDp, gapDp }
		const resolution = navigation
			? resolveThemeNavigation(policy, measurements)
			: resolveThemeControlRow(policy, measurements)
		return resolution.kind === 'rejected'
			? { kind: 'rejected', resolution }
			: { kind: 'ready', resolution }
	}, [policy, controlMinWidthsDp, navigation, gapDp, width])
	const targets = useMemo<ThemeControlTargetLayout[]>(
		() =>
			status.kind === 'ready'
				? status.resolution.minWidthsDp.map((minimumWidthDp) => ({
						touchDp: status.resolution.touchDp,
						minimumWidthDp,
						fill: single,
						availableWidthDp: width,
					}))
				: [],
		[status, single, width],
	)
	useEffect(() => {
		if (current.current !== token) return
		if (!policy || !onStatusChange) {
			lastReport.current = null
			return
		}
		const report = JSON.stringify(status)
		const previous = lastReport.current
		if (
			previous?.receiver !== onStatusChange ||
			previous.token !== token ||
			previous.value !== report
		) {
			lastReport.current = { receiver: onStatusChange, token, value: report }
			onStatusChange(status)
		}
	}, [status, policy, onStatusChange, token])
	if (!policy) {
		if (typeof children === 'function')
			throw new Error('Measured child rendering requires a package policy')
		return (
			<View
				style={style}
				testID={testID}
			>
				{children}
			</View>
		)
	}
	const renderControls = () => {
		if (status.kind !== 'ready') return null
		if (typeof children === 'function') {
			if (controlMinWidthsDp.length !== 1)
				throw new Error('Measured child rendering requires one control')
			return children(targets[0])
		}
		const controls = React.Children.toArray(children)
		if (controls.length !== controlMinWidthsDp.length)
			throw new Error(
				'Every measured control needs a corresponding host minimum',
			)
		return controls.map((child, index) => {
			if (!React.isValidElement(child))
				throw new Error('Control rows require element children')
			return (
				<Context.Provider
					key={child.key}
					value={targets[index]}
				>
					{child}
				</Context.Provider>
			)
		})
	}
	return (
		<View
			testID={testID}
			style={[
				style,
				{ flexDirection: 'row', flexWrap: 'nowrap', maxWidth: '100%' },
			]}
		>
			<View
				key={`${generation}:${key}`}
				onLayout={({ nativeEvent }) => {
					if (current.current !== token) return
					const next = nativeEvent.layout.width
					setMeasured({
						token,
						width: Number.isFinite(next) && next > 0 ? next : 0,
					})
				}}
				style={{
					flex: 1,
					flexDirection: 'row',
					flexWrap: 'nowrap',
					alignItems: rowStyle?.alignItems,
					justifyContent: rowStyle?.justifyContent,
					gap: gapDp,
				}}
			>
				{status.kind === 'ready' ? (
					renderControls()
				) : status.kind === 'rejected' ? (
					<Text
						accessibilityLiveRegion={announceStatus ? 'polite' : 'none'}
						style={{ color: errorColor, flex: 1 }}
					>
						主题控件暂不适合当前宽度，请返回主题工坊使用兼容主题。
					</Text>
				) : (
					<View
						accessible={false}
						pointerEvents='none'
						style={{ minHeight: policy.minTouchDp }}
					/>
				)}
			</View>
		</View>
	)
}
