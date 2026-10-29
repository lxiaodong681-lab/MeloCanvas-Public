import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { builtInThemes } from './core/theme'
import { themeAppearance, type ColorMode } from './core/theme-appearance'
import {
	ThemePresentationTransientError,
	ThemeLayoutRejectedError,
	type ThemeInstallDependencies,
	type ThemePresentation,
} from './core/theme-install-types'
import type { ThemeLayoutGate } from './theme-layout-gate'
import { createPackageRendering } from './theme-renderer'

const modern: ThemePresentation = {
	selection: { kind: 'builtin', key: 'modern' },
	theme: builtInThemes.modern,
	adapted: null,
	packageMetadata: null,
	allowedImageUris: [],
}
export function requiresCurrentLayout(
	presentation: ThemePresentation,
): boolean {
	return (
		presentation.selection.kind === 'package' &&
		!!presentation.adapted &&
		!!createPackageRendering(
			presentation.adapted,
			presentation.allowedImageUris,
			true,
		).controlRowLayout
	)
}

/** Opt-in App policy: verification still precedes this hook. Only cold restoration
 * delegates layout to the live current observer; preview/apply/undo stay strict. */
export function withCurrentLayoutRestore(
	prepare: NonNullable<ThemeInstallDependencies['preparePresentation']>,
): NonNullable<ThemeInstallDependencies['preparePresentation']> {
	return (presentation, context) => {
		if (context.purpose !== 'restore' || !requiresCurrentLayout(presentation))
			return prepare(presentation, context)
		const assertCurrent = () => {
			if (context.signal.aborted)
				throw new ThemePresentationTransientError('cancelled', '主题恢复已取消')
		}
		assertCurrent()
		return Promise.resolve({ assertCurrent })
	}
}

export interface CurrentThemeDisplay {
	presentation: ThemePresentation
	temporaryModern: boolean
	reason: string | null
}

/** Display authority over a verified durable choice. Never calls installer writes. */
export function useThemeCurrentLayout(
	presentation: ThemePresentation,
	gate: ThemeLayoutGate,
	environmentIdentity: object,
	mode: ColorMode = 'light',
) {
	const state = useSyncExternalStore(gate.subscribe, gate.getSnapshot)
	const protectedPackage = useMemo(() => requiresCurrentLayout(presentation), [presentation])
	const [rejectedVisit, setRejectedVisit] = useState<object | null>(null)
	const visit = useMemo(
		() => ({
			presentation,
			gate,
			environmentIdentity,
			revision: state.environmentRevision,
		}),
		[presentation, gate, environmentIdentity, state.environmentRevision],
	)
	useLayoutEffect(() => {
		if (!protectedPackage) return
		const controller = new AbortController()
		const pending = gate.observeCurrent(presentation, controller.signal, visit)
		void pending.catch((error: unknown) => {
			if (!controller.signal.aborted && error instanceof ThemeLayoutRejectedError)
				setRejectedVisit(visit)
		})
		return () => controller.abort()
	}, [protectedPackage, presentation, gate, visit])
	const ready =
		state.phase === 'ready' &&
		state.request?.currentVisit === visit &&
		state.request.presentation === presentation &&
		state.environmentRevision !== null
	const temporaryModern = protectedPackage && !ready
	const reason = !temporaryModern
		? null
		: state.phase === 'rejected'
			? '所选主题暂不适合当前窗口或字体，临时使用现代主题；适配后会自动恢复。'
			: '正在检查所选主题的显示适配，暂用现代主题；适配后会自动恢复。'
	const display: CurrentThemeDisplay = {
		presentation: temporaryModern ? themeAppearance(modern, mode) : presentation,
		temporaryModern,
		reason: mode === 'dark' ? reason?.replaceAll('现代主题', '宇宙外观') ?? null : reason,
	}
	// A previous visit's rejection is not a verdict on this presentation.
	const rejected = rejectedVisit === visit
	return { ...display, pending: temporaryModern && !rejected, request: state.request }
}
