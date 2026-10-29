import { useMemo, useSyncExternalStore } from 'react'

import {
	ThemePresentationTransientError,
	type ThemeInstallDependencies,
} from './core/theme-install-types'
import { ThemeLayoutGate } from './theme-layout-gate'
import { createPackageRendering } from './theme-renderer'
import {
	useThemeLayoutHost,
	type ThemeLayoutInsets,
} from './useThemeLayoutHost'

/** Candidate preflight only. Durable/current display policy remains with the installer. */
export function useThemeCandidateLayout(
	insets: ThemeLayoutInsets,
	currentGate?: ThemeLayoutGate,
) {
	const gate = useMemo(() => new ThemeLayoutGate(), [])
	const host = useThemeLayoutHost(gate, insets, currentGate)
	const state = useSyncExternalStore(gate.subscribe, gate.getSnapshot)
	const preparePresentation = useMemo<
		NonNullable<ThemeInstallDependencies['preparePresentation']>
	>(
		() => (presentation, context) => {
			const assertNotCancelled = () => {
				if (context.signal.aborted)
					throw new ThemePresentationTransientError(
						'cancelled',
						'主题测量已取消',
					)
			}
			assertNotCancelled()
			if (
				presentation.selection.kind === 'package' &&
				presentation.adapted &&
				createPackageRendering(
					presentation.adapted,
					presentation.allowedImageUris,
					true,
				).controlRowLayout
			)
				return gate.preparePresentation(presentation, context)
			return Promise.resolve({ assertCurrent: assertNotCancelled })
		},
		[gate],
	)
	return { ...host, gate, request: state.request, preparePresentation }
}
