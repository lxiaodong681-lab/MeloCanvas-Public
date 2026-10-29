import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
	useWindowDimensions,
	type LayoutChangeEvent,
	type View,
} from 'react-native'

import type { ThemeLayoutGate } from './theme-layout-gate'

export interface ThemeLayoutInsets {
	top: number
	right: number
	bottom: number
	left: number
}
export interface ThemeLayoutRootBounds {
	width: number
	height: number
}

/** Wire onRootLayout to the existing content root, not a viewport-size estimate. */
export function useThemeLayoutHost(
	gate: ThemeLayoutGate,
	insets: ThemeLayoutInsets,
	currentGate?: ThemeLayoutGate,
) {
	const gates = useMemo(
		() => (currentGate && currentGate !== gate ? [gate, currentGate] : [gate]),
		[gate, currentGate],
	)
	const {
		fontScale,
		width: viewportWidth,
		height: viewportHeight,
	} = useWindowDimensions()
	const [measurement, setMeasurement] = useState<{
		token: object
		bounds: ThemeLayoutRootBounds | null
	} | null>(null)
	const identity = useMemo(() => ({ gates }), [gates])
	const measurementToken = useMemo(
		() => ({ gates, viewportWidth, viewportHeight }),
		[gates, viewportWidth, viewportHeight],
	)
	// Also changes synchronously during render, before the shared layout effect
	// invalidates leases: current display must not use an earlier environment.
	const environmentIdentity = useMemo(
		() => ({
			measurementToken,
			fontScale,
			top: insets.top,
			right: insets.right,
			bottom: insets.bottom,
			left: insets.left,
		}),
		[
			measurementToken,
			fontScale,
			insets.top,
			insets.right,
			insets.bottom,
			insets.left,
		],
	)
	const current = useRef<object | null>(null)
	const currentMeasurement = useRef<object | null>(null)
	const rootRef = useRef<View | null>(null)
	const rootRead = useRef(0)
	const observation = useRef({
		bounds: null as ThemeLayoutRootBounds | null,
		context: [
			fontScale,
			viewportWidth,
			viewportHeight,
			insets.top,
			insets.right,
			insets.bottom,
			insets.left,
		],
		key: null as string | null,
		revision: 0,
	})
	const publish = useMemo(
		() => () => {
			if (current.current !== identity) return
			const value = observation.current
			const known =
				value.bounds &&
				value.context.every(Number.isFinite) &&
				value.context[0] > 0
			const key = known ? JSON.stringify([value.bounds, value.context]) : null
			if (key === value.key) return
			value.key = key
			const revision = key === null ? null : ++value.revision
			for (const target of gates) target.setEnvironmentRevision(revision)
		},
		[gates, identity],
	)
	useLayoutEffect(() => {
		current.current = identity
		observation.current.key = null
		for (const target of gates) target.setEnvironmentRevision(null)
		return () => {
			if (current.current !== identity) return
			current.current = null
			for (const target of gates) {
				target.stop()
				target.setEnvironmentRevision(null)
			}
		}
	}, [gates, identity])
	useLayoutEffect(() => {
		currentMeasurement.current = measurementToken
		observation.current.bounds = null
		publish()
		return () => {
			if (currentMeasurement.current === measurementToken)
				currentMeasurement.current = null
		}
	}, [measurementToken, publish])
	useLayoutEffect(() => {
		observation.current.context = [
			fontScale,
			viewportWidth,
			viewportHeight,
			insets.top,
			insets.right,
			insets.bottom,
			insets.left,
		]
		publish()
	}, [
		fontScale,
		viewportWidth,
		viewportHeight,
		insets.top,
		insets.right,
		insets.bottom,
		insets.left,
		publish,
	])
	const acceptBounds = useMemo(
		() => (width: number, height: number) => {
			if (
				current.current !== identity ||
				currentMeasurement.current !== measurementToken
			)
				return
			const next =
				Number.isFinite(width) &&
				width > 0 &&
				Number.isFinite(height) &&
				height > 0
					? { width, height }
					: null
			observation.current.bounds = next
			// Invalidate before scheduling React state; an old lease cannot commit in between.
			publish()
			setMeasurement((previous) =>
				previous?.token === measurementToken &&
				previous.bounds?.width === next?.width &&
				previous.bounds?.height === next?.height
					? previous
					: { token: measurementToken, bounds: next },
			)
		},
		[identity, measurementToken, publish],
	)
	const onRootLayout = useMemo(
		() =>
			({ nativeEvent }: LayoutChangeEvent) => {
				if (
					current.current !== identity ||
					currentMeasurement.current !== measurementToken
				)
					return
				rootRead.current++
				acceptBounds(nativeEvent.layout.width, nativeEvent.layout.height)
			},
		[acceptBounds, identity, measurementToken],
	)
	useLayoutEffect(() => {
		const root = rootRef.current
		const read = ++rootRead.current
		root?.measure((_x, _y, width, height) => {
			if (rootRef.current === root && rootRead.current === read)
				acceptBounds(width, height)
		})
	}, [acceptBounds])
	const bounds =
		measurement?.token === measurementToken ? measurement.bounds : null
	return { bounds, onRootLayout, rootRef, environmentIdentity }
}
