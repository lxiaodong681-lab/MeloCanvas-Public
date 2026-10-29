import type { ThemeFilesNativeModule } from '../../../../packages/native/src/ThemeFilesModule'

import type { Library } from './database'
import { validThemeKey, type ThemeKey } from './theme'
import { parseRegistry, ThemeInstallSession } from './theme-install-session'
import type {
	ThemeFilesDriver,
	ThemeSettingsDriver,
} from './theme-install-types'
import type { ThemeInstallDependencies } from './theme-install-types'
import { ThemePresentationTransientError } from './theme-install-types'
import { themePackageLimits } from './theme-package-types'

export const themeStateKey = 'theme.state.v1'

/** Read the durable builtin choice synchronously; packages still require validation. */
export function readStartupBuiltinTheme(library: Pick<Library, 'setting'>): ThemeKey {
	const raw = library.setting(themeStateKey)
	if (raw !== null) {
		const active = parseRegistry(raw).active
		return active.kind === 'builtin' ? active.key : 'modern'
	}
	return validThemeKey(library.setting('theme'))
}

export function createThemeSettingsDriver(
	library: Pick<Library, 'setting' | 'setSetting'>,
): ThemeSettingsDriver {
	return {
		read: () => library.setting(themeStateKey),
		readLegacy: () => library.setting('theme'),
		commit: (expected, value) => {
			// No await between comparison and the one-statement SQLite write.
			if (library.setting(themeStateKey) !== expected)
				throw new Error('主题记录已被其他会话修改，请重新加载')
			library.setSetting(themeStateKey, value)
		},
	}
}
function boundedNativeBytes(value: unknown, max: number): Uint8Array {
	if (!(value instanceof Uint8Array) || value.length > max)
		throw new Error('原生主题读取结果无效或超限')
	return value
}

/** No Expo File/Directory fallback: the native confined operations are required. */
async function nativeFiles(): Promise<ThemeFilesNativeModule> {
	return (
		await import('../../../../packages/native/src/ThemeFilesModule')
	).getThemeFilesModule()
}
export async function createMobileThemeFiles(
	injected?: ThemeFilesNativeModule,
): Promise<ThemeFilesDriver> {
	const native = injected ?? (await nativeFiles())
	const installedRootUri = await native.rootAsync()
	const owned = new Map<string, string>()
	const scope = (value: Parameters<ThemeFilesDriver['read']>[0]) => {
		if (value === 'installed') return value
		if (owned.get(value.token) !== value.privateRootUri)
			throw new Error('主题暂存目录不属于本会话')
		return value.token
	}
	return {
		installedRootUri,
		...(native.readVerifiedAsync && native.writeVerifiedAsync ? {
			readVerified: (id: string, hash: string, context: string) => native.readVerifiedAsync!(id, hash, context),
			writeVerified: (id: string, hash: string, context: string, payload: string, entries: { path: string; bytes: number; sha256: string }[]) => native.writeVerifiedAsync!(id, hash, context, payload, entries),
		} : {}),
		...(native.removeInstalledAsync ? {
			removeInstalled: (id: string, hash: string, token: string) => native.removeInstalledAsync!(id, hash, token),
		} : {}),
		createStage: async () => {
			const stage = await native.createStageAsync()
			owned.set(stage.token, stage.privateRootUri)
			return stage
		},
		writeStage: async (stage, path, bytes) => {
			if (
				!(bytes instanceof Uint8Array) ||
				bytes.length > themePackageLimits.archiveBytes
			)
				throw new Error('主题写入超限')
			await native.writeStageAsync(scope(stage), path, bytes)
		},
		read: async (value, path, maxBytes) => {
			if (
				!Number.isSafeInteger(maxBytes) ||
				maxBytes < 1 ||
				maxBytes > themePackageLimits.archiveBytes
			)
				throw new Error('主题读取预算无效')
			return boundedNativeBytes(
				await native.readAsync(scope(value), path, maxBytes),
				maxBytes,
			)
		},
		list: (value, path) => native.listAsync(scope(value), path),
		publish: (stage, id, hash) => native.publishAsync(scope(stage), id, hash),
		removeStage: async (stage) => {
			await native.removeStageAsync(scope(stage))
			owned.delete(stage.token)
		},
	}
}

/** Call only for a URI returned by the user's document picker. Native bounds the stream. */
let selectedReadBusy = false
export async function readSelectedThemeBytes(
	uri: string,
	native?: ThemeFilesNativeModule,
): Promise<Uint8Array> {
	if (selectedReadBusy) throw new Error('上一次主题文件仍在读取，请等待后重试')
	selectedReadBusy = true
	try {
		return boundedNativeBytes(
			await (native ?? (await nativeFiles())).readSelectedAsync(uri),
			themePackageLimits.archiveBytes,
		)
	} finally {
		selectedReadBusy = false
	}
}

export async function createMobileThemeInstallSession(
	library: Pick<Library, 'setting' | 'setSetting'>,
	options: Pick<
		ThemeInstallDependencies,
		'host' | 'decoder' | 'mode' | 'preparePresentation'
	> & {
		/** Trusted App opt-in only: candidate probes plus the current-display guard.
		 * This is an integration contract, not proof that an arbitrary callback measures. */
		responsiveLayoutHost?: boolean
	},
	native?: ThemeFilesNativeModule,
): Promise<ThemeInstallSession> {
	const responsiveHost =
		options.responsiveLayoutHost === true && !!options.preparePresentation
	return new ThemeInstallSession({
		...options,
		host: {
			...options.host,
			// A missing live layout host is not evidence of package corruption.
			// Do not hide another unsupported capability or grant the absent one.
			onMissingCapabilities: (missing) => {
				if (
					!responsiveHost &&
					missing.length === 1 &&
					missing[0] === 'responsive-touch-layout-v1'
				)
					throw new ThemePresentationTransientError(
						'unavailable',
						'当前响应式主题宿主尚未就绪，请重新打开主题工坊',
					)
			},
		},
		files: await createMobileThemeFiles(native),
		settings: createThemeSettingsDriver(library),
		validatePresentation: (presentation) => {
			const retained = presentation.adapted?.retained
			if (!retained) return
			// Old larger packages never authorized compact/host fallback. Keep the
			// existing static rejection rather than silently shrinking their targets.
			if (retained.buttonMinTouchDp > 48 && !retained.controlRowLayout)
				throw new Error(
					'大于48dp的旧主题缺少明确的响应式布局策略，请使用兼容主题',
				)
			if (retained.controlRowLayout && !responsiveHost)
				throw new ThemePresentationTransientError(
					'unavailable',
					'当前响应式主题宿主尚未就绪，请重新打开主题工坊',
				)
		},
	})
}
