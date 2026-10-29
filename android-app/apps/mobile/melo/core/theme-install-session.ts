import { builtInThemes, validThemeKey, type ThemeKey } from './theme'
import { sha256, safePackagePath } from './theme-archive'
import {
	ThemeLayoutRejectedError,
	ThemePresentationTransientError,
	type InstalledThemeRecord,
	type ThemeInstallDependencies,
	type ThemeInstallSnapshot,
	type ThemePresentation,
	type ThemePresentationLease,
	type ThemePresentationPurpose,
	type ThemeRegistryV1,
	type ThemeSelection,
	type ThemeStage,
} from './theme-install-types'
import { validateThemePackage } from './theme-package'
import {
	adaptPackageTheme,
	type InstalledThemeBindings,
} from './theme-package-adapter'
import {
	themePackageLimits,
	type VerifiedThemePackage,
} from './theme-package-types'

const digestPattern = /^[a-f0-9]{64}$/
const idPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/
const failure = (error: unknown) =>
	error instanceof Error ? error : new Error(String(error))
const modern: ThemeSelection = { kind: 'builtin', key: 'modern' }
interface PreparedPresentation {
	presentation: ThemePresentation
	lease: ThemePresentationLease
	installedRecord?: InstalledThemeRecord
}
function preparationFailure(error: unknown): Error {
	if (
		error instanceof ThemePresentationTransientError ||
		error instanceof ThemeLayoutRejectedError
	)
		return error
	return new ThemePresentationTransientError(
		'unavailable',
		'主题显示准备暂不可用，请重新尝试',
		{ cause: error },
	)
}
function preparedBuiltin(key: ThemeKey): PreparedPresentation {
	return { presentation: builtin(key), lease: { assertCurrent() {} } }
}
function waitForLease(
	pending: Promise<ThemePresentationLease>,
	signal: AbortSignal,
): Promise<ThemePresentationLease> {
	return new Promise((finish, fail) => {
		const abort = () => {
			signal.removeEventListener('abort', abort)
			fail(new ThemePresentationTransientError('cancelled', '主题操作已取消'))
		}
		signal.addEventListener('abort', abort, { once: true })
		// A host measurement may ignore abort. Release only this new wait boundary,
		// while observing both late outcomes so they cannot publish or go unhandled.
		pending.then(
			(lease) => {
				signal.removeEventListener('abort', abort)
				finish(lease)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', abort)
				fail(error)
			},
		)
		if (signal.aborted) abort()
	})
}
function previousFor(
	registry: ThemeRegistryV1,
	next: ThemeSelection,
): ThemeSelection | null {
	return JSON.stringify(registry.active) === JSON.stringify(next)
		? registry.previous
		: registry.active
}
function builtin(key: ThemeKey): ThemePresentation {
	return {
		selection: { kind: 'builtin', key },
		theme: structuredCopy(builtInThemes[key]),
		adapted: null,
		packageMetadata: null,
		allowedImageUris: [],
	}
}
function structuredCopy<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('主题安装记录损坏')
	return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[]) {
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		throw new Error('主题安装记录含未支持字段')
}
function selection(value: unknown): ThemeSelection {
	const raw = object(value)
	keys(
		raw,
		raw.kind === 'builtin' ? ['kind', 'key'] : ['kind', 'id', 'archiveSha256'],
	)
	if (
		raw.kind === 'builtin' &&
		typeof raw.key === 'string' &&
		['modern', 'pastoral', 'anime'].includes(raw.key)
	)
		return { kind: 'builtin', key: raw.key as ThemeKey }
	if (
		raw.kind === 'package' &&
		typeof raw.id === 'string' &&
		idPattern.test(raw.id) &&
		typeof raw.archiveSha256 === 'string' &&
		digestPattern.test(raw.archiveSha256)
	)
		return { kind: 'package', id: raw.id, archiveSha256: raw.archiveSha256 }
	throw new Error('主题安装指针损坏')
}
export function parseRegistry(text: string): ThemeRegistryV1 {
	if (text.length > 256 * 1024) throw new Error('主题安装记录超限')
	const raw = object(JSON.parse(text))
	keys(raw, ['schemaVersion', 'revision', 'installed', 'active', 'previous', 'pendingRemoval'])
	if (
		raw.schemaVersion !== 1 ||
		!Number.isSafeInteger(raw.revision) ||
		(raw.revision as number) < 0 ||
		!Array.isArray(raw.installed) ||
		raw.installed.length > 200
	)
		throw new Error('主题安装记录不兼容或损坏')
	const seen = new Set<string>()
	const installed = raw.installed.map((item) => {
		const record = object(item)
		keys(record, ['id', 'version', 'name', 'archiveSha256', 'storedBytes'])
		if (
			typeof record.id !== 'string' ||
			record.id.length > 100 ||
			!idPattern.test(record.id) ||
			record.id.startsWith('melocanvas.builtin.') ||
			typeof record.archiveSha256 !== 'string' ||
			!digestPattern.test(record.archiveSha256) ||
			typeof record.version !== 'string' ||
			!record.version ||
			record.version.length > 80 ||
			typeof record.name !== 'string' ||
			!record.name ||
			record.name.length > 256
		)
			throw new Error('已安装主题记录损坏')
		if (record.storedBytes !== undefined && (!Number.isSafeInteger(record.storedBytes) || (record.storedBytes as number) < 1 || (record.storedBytes as number) > 80 * 1024 * 1024))
			throw new Error('主题占用记录损坏')
		const key = `${record.id}/${record.archiveSha256}`
		if (seen.has(key)) throw new Error('已安装主题记录重复')
		seen.add(key)
		return {
			id: record.id,
			version: record.version,
			name: record.name,
			archiveSha256: record.archiveSha256,
			...(record.storedBytes === undefined ? {} : { storedBytes: record.storedBytes as number }),
		}
	})
	const active = selection(raw.active),
		previous = raw.previous === null ? null : selection(raw.previous)
	for (const pointer of [active, previous])
		if (
			pointer?.kind === 'package' &&
			!seen.has(`${pointer.id}/${pointer.archiveSha256}`)
		)
			throw new Error('主题指针不在安装记录中')
	if (raw.pendingRemoval !== undefined && (!Array.isArray(raw.pendingRemoval) || raw.pendingRemoval.length > 200))
		throw new Error('主题清理记录损坏')
	const pendingRemoval = ((raw.pendingRemoval ?? []) as unknown[]).map((entry) => {
		const item = object(entry)
		keys(item, ['id', 'archiveSha256', 'token'])
		const pointer = selection({ id: item.id, archiveSha256: item.archiveSha256, kind: 'package' })
		if (pointer.kind !== 'package' || pointer.id.length > 100 || seen.has(`${pointer.id}/${pointer.archiveSha256}`))
			throw new Error('主题清理记录冲突')
		if (typeof item.token !== 'string' || !/^[a-z0-9-]{1,100}$/.test(item.token)) throw new Error('主题清理标识损坏')
		return { id: pointer.id, archiveSha256: pointer.archiveSha256, token: item.token }
	})
	return {
		schemaVersion: 1,
		revision: raw.revision as number,
		installed,
		active,
		previous,
		...(pendingRemoval.length ? { pendingRemoval } : {}),
	}
}

/** One session serializes disk work and uses epochs so stale work cannot commit. */
export class ThemeInstallSession {
	private state: ThemeInstallSnapshot = {
		phase: 'idle',
		current: builtin('modern'),
		preview: null,
		installed: [],
		revision: 0,
		canUndo: false,
		readOnly: false,
		error: null,
		cleanupErrors: [],
	}
	private readonly listeners = new Set<() => void>()
	private registry: ThemeRegistryV1 | null = null
	private stored: string | null = null
	private tail: Promise<unknown> = Promise.resolve()
	private epoch = 0
	private controller: AbortController | null = null
	private importAdmitted = false
	private previewData: {
		stage: ThemeStage
		record: InstalledThemeRecord
	} | null = null
	constructor(private readonly deps: ThemeInstallDependencies) {}
	getSnapshot = (): ThemeInstallSnapshot => this.state
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	private update(patch: Partial<ThemeInstallSnapshot>) {
		this.state = { ...this.state, ...patch }
		for (const listener of this.listeners) listener()
	}
	private async cleanup(stage: ThemeStage) {
		try {
			await this.deps.files.removeStage(stage)
		} catch (error) {
			this.update({
				cleanupErrors: [...this.state.cleanupErrors, failure(error)],
			})
		}
	}
	private async clearPreview() {
		const data = this.previewData
		this.previewData = null
		this.update({ preview: null })
		if (data) await this.cleanup(data.stage)
	}
	private work(
		phase: ThemeInstallSnapshot['phase'],
		action: (check: () => void, signal: AbortSignal) => Promise<void>,
	): Promise<boolean> {
		const epoch = ++this.epoch
		this.controller?.abort()
		const controller = new AbortController()
		this.controller = controller
		const check = () => {
			if (epoch !== this.epoch || controller.signal.aborted)
				throw new ThemePresentationTransientError('cancelled', '主题操作已取消')
		}
		const result = this.tail.then(async () => {
			if (epoch !== this.epoch) return false
			this.update({ phase, error: null })
			try {
				await action(check, controller.signal)
				check()
				return true
			} catch (error) {
				if (epoch === this.epoch)
					this.update({ phase: 'error', error: failure(error) })
				return false
			}
		})
		this.tail = result.catch(() => undefined)
		return result
	}
	private writable(): ThemeRegistryV1 {
		if (!this.registry || this.state.readOnly)
			throw new Error('主题记录不可写，请先重新加载并处理记录错误')
		if (this.registry.pendingRemoval?.length)
			throw new Error('主题文件尚未清理完成，请重新加载主题以重试清理')
		return this.registry
	}
	private commit(
		next: ThemeRegistryV1,
		current: PreparedPresentation,
		check: () => void,
		expected = this.stored,
	) {
		if (
			!Number.isSafeInteger(next.revision) ||
			next.revision > Number.MAX_SAFE_INTEGER
		)
			throw new Error('主题记录版本超限')
		const value = JSON.stringify(next)
		// The settings adapter performs one synchronous SQLite statement. No async
		// gap exists between lease + epoch checks, durable pointer and memory swap.
		this.assertPrepared(current, check)
		this.deps.settings.commit(expected, value)
		this.stored = value
		this.registry = next
		this.update({
			current: current.presentation,
			installed: structuredCopy(next.installed),
			revision: next.revision,
			canUndo: next.previous !== null,
			phase: 'ready',
			preview: null,
			readOnly: false,
		})
	}
	private async prepare(
		presentation: ThemePresentation,
		purpose: ThemePresentationPurpose,
		check: () => void,
		signal: AbortSignal,
	): Promise<PreparedPresentation> {
		check()
		let lease: ThemePresentationLease = { assertCurrent() {} }
		if (this.deps.preparePresentation) {
			try {
				lease = await waitForLease(
					this.deps.preparePresentation(presentation, { purpose, signal }),
					signal,
				)
			} catch (error) {
				check()
				throw preparationFailure(error)
			}
		}
		check()
		return { presentation, lease }
	}
	private assertPrepared(current: PreparedPresentation, check: () => void) {
		try {
			current.lease.assertCurrent()
		} catch (error) {
			throw preparationFailure(error)
		}
		// The host callback may synchronously cancel/start a newer operation.
		check()
	}
	private presentation(
		value: VerifiedThemePackage,
		rootUri: string,
		bytes: number,
	): ThemePresentation {
		const binding: InstalledThemeBindings = {
			package: { ...value.snapshot.package },
			rootUri: `${rootUri}${value.manifest.id}/${value.snapshot.package.archiveSha256}/`,
			resources: value.snapshot.resources.map((resource) => ({
				path: resource.path,
				sha256: resource.sha256,
				uri: `${rootUri}${value.manifest.id}/${value.snapshot.package.archiveSha256}/${resource.path}`,
			})),
		}
		const adapted = adaptPackageTheme(value, binding, {
			mode: this.deps.mode,
			host: this.deps.host,
			privateThemesRootUri: rootUri,
		})
		const result: ThemePresentation = {
			...(value.snapshot.tokens.dark &&
			this.deps.host.capabilities.includes('dark-tokens')
				? {
						darkAdapted:
							this.deps.mode === 'dark'
								? adapted
								: adaptPackageTheme(value, binding, {
										mode: 'dark',
										host: this.deps.host,
										privateThemesRootUri: rootUri,
									}),
					}
				: {}),
			selection: {
				kind: 'package',
				id: value.manifest.id,
				archiveSha256: value.snapshot.package.archiveSha256,
			},
			theme: adapted.theme,
			adapted,
			packageMetadata: {
				name: value.manifest.name,
				author: value.manifest.author,
				license: value.manifest.license,
				version: value.manifest.version,
				archiveBytes: bytes,
			},
			allowedImageUris: binding.resources.map((resource) => resource.uri),
		}
		this.deps.validatePresentation?.(result)
		return result
	}
	private async verifyDisk(
		scope: ThemeStage | 'installed',
		record: { id: string; archiveSha256: string; version?: string },
		check: () => void,
		signal: AbortSignal,
	): Promise<{
		record: InstalledThemeRecord
		presentation: ThemePresentation
	}> {
		const leaf = `${record.id}/${record.archiveSha256}`
		if (
			!idPattern.test(record.id) ||
			record.id.length > 100 ||
			!digestPattern.test(record.archiveSha256)
		)
			throw new Error('主题安装身份无效')
		const cacheContext = JSON.stringify({ format: 'theme-presentation-v1', host: this.deps.host.appVersion,
			capabilities: [...this.deps.host.capabilities].sort(), mode: this.deps.mode, root: this.deps.files.installedRootUri })
		if (scope === 'installed' && this.deps.files.readVerified) {
			let cached: { record: InstalledThemeRecord; presentation: ThemePresentation } | null = null
			try {
				const text = await this.deps.files.readVerified(record.id, record.archiveSha256, cacheContext)
				if (text && text.length <= 512 * 1024) cached = JSON.parse(text) as { record: InstalledThemeRecord; presentation: ThemePresentation }
			} catch { /* Missing receipts use the original full validation path. */ }
			check()
			if (cached?.record?.id === record.id && cached.record.archiveSha256 === record.archiveSha256 &&
				(record.version === undefined || cached.record.version === record.version) &&
				cached.presentation?.selection?.kind === 'package' && cached.presentation.selection.id === record.id &&
				cached.presentation.selection.archiveSha256 === record.archiveSha256) {
				this.deps.validatePresentation?.(cached.presentation)
				return cached
			}
		}
		const bytes = await this.deps.files.read(
			scope,
			`${leaf}/archive.melotheme`,
			themePackageLimits.archiveBytes,
		)
		check()
		const value = await validateThemePackage(
			bytes,
			this.deps.host,
			this.deps.decoder,
			{ signal },
		)
		check()
		if (
			value.manifest.id !== record.id ||
			value.snapshot.package.archiveSha256 !== record.archiveSha256 ||
			(record.version !== undefined &&
				value.manifest.version !== record.version)
		)
			throw new Error('安装主题原归档身份不一致')
		const expected = new Map([
			...value.files.map(
				(file) =>
					[
						file.path,
						{ bytes: file.bytes.length, sha256: file.sha256 },
					] as const,
			),
			[
				'archive.melotheme',
				{ bytes: bytes.length, sha256: sha256(bytes) },
			] as const,
		])
		const entries = await this.deps.files.list(scope, leaf)
		// All byte integrity facts are now in expected. Do not retain the expanded
		// payload while reading it back, or in the UI's long-lived preview state.
		value.files = []
		check()
		if (
			entries.length !== expected.size ||
			new Set(entries.map((entry) => entry.path)).size !== entries.length
		)
			throw new Error('安装主题文件清单不完整')
		for (const entry of entries) {
			safePackagePath(entry.path)
			const file = expected.get(entry.path)
			if (!file || entry.bytes !== file.bytes)
				throw new Error('安装主题文件长度不一致')
			const actual = await this.deps.files.read(
				scope,
				`${leaf}/${entry.path}`,
				Math.max(1, file.bytes),
			)
			check()
			if (actual.length !== file.bytes || sha256(actual) !== file.sha256)
				throw new Error('安装主题落盘字节校验失败')
		}
		const result = {
			record: { ...value.snapshot.package, name: value.manifest.name, storedBytes: entries.reduce((total, entry) => total + entry.bytes, 0) },
			presentation: this.presentation(
				value,
				scope === 'installed'
					? this.deps.files.installedRootUri
					: scope.privateRootUri,
				bytes.length,
			),
		}
		if (scope === 'installed' && this.deps.files.writeVerified) {
			try {
				await this.deps.files.writeVerified(record.id, record.archiveSha256, cacheContext, JSON.stringify(result),
					[...expected].map(([path, file]) => ({ path, ...file })))
			} catch { /* Cache write failure must not prevent use of verified files. */ }
			check()
		}
		return result
	}
	private async resolve(
		pointer: ThemeSelection,
		registry: ThemeRegistryV1,
		check: () => void,
		signal: AbortSignal,
		purpose: ThemePresentationPurpose,
	): Promise<PreparedPresentation> {
		if (pointer.kind === 'builtin') return preparedBuiltin(pointer.key)
		const record = registry.installed.find(
			(item) =>
				item.id === pointer.id && item.archiveSha256 === pointer.archiveSha256,
		)
		if (!record) throw new Error('主题未安装')
		const disk = await this.verifyDisk('installed', record, check, signal)
		return { ...await this.prepare(disk.presentation, purpose, check, signal), installedRecord: disk.record }
	}
	load(): Promise<boolean> {
		return this.work('loading', async (check, signal) => {
			this.update({ readOnly: true, canUndo: false })
			await this.clearPreview()
			check()
			let raw: string | null, registry: ThemeRegistryV1
			try {
				raw = this.deps.settings.read()
				registry =
					raw === null
						? {
								schemaVersion: 1,
								revision: 0,
								installed: [],
								active: {
									kind: 'builtin',
									key: validThemeKey(this.deps.settings.readLegacy()),
								},
								previous: null,
							}
						: parseRegistry(raw)
			} catch (error) {
				this.update({ readOnly: true })
				throw error
			}
			check()
			// Unregister first, then reclaim files. A crash or I/O failure leaves a
			// durable retry record rather than resurrecting a partly deleted theme.
			let cleanupError: Error | null = null
			if (registry.pendingRemoval?.length) {
				try {
					if (!this.deps.files.removeInstalled) throw new Error('当前版本不支持清理主题文件，请更新应用')
					for (const item of registry.pendingRemoval) {
						await this.deps.files.removeInstalled(item.id, item.archiveSha256, item.token)
						check()
					}
					const next = { ...registry, revision: registry.revision + 1, pendingRemoval: [] }
					const text = JSON.stringify(next)
					this.deps.settings.commit(raw, text)
					raw = text
					registry = next
				} catch {
					check()
					cleanupError = new Error('本地主题文件尚未清理完成，请重新加载主题以重试清理。')
				}
			}
			let current: PreparedPresentation
			try {
				current = await this.resolve(
					registry.active,
					registry,
					check,
					signal,
					'restore',
				)
			} catch (activeError) {
				check()
				if (activeError instanceof ThemePresentationTransientError)
					throw activeError
				let fallback: PreparedPresentation
				try {
					fallback = registry.previous
						? await this.resolve(
								registry.previous,
								registry,
								check,
								signal,
								'restore',
							)
						: preparedBuiltin('modern')
				} catch (error) {
					check()
					if (error instanceof ThemePresentationTransientError) throw error
					fallback = preparedBuiltin('modern')
				}
				const next = {
					...registry,
					revision: registry.revision + 1,
					active: fallback.presentation.selection,
					previous:
						fallback.presentation.selection.kind === 'builtin' &&
						fallback.presentation.selection.key === 'modern'
							? null
							: modern,
				}
				this.commit(next, fallback, check, raw)
				this.update({ error: failure(activeError) })
				return
			}
			if (raw === null)
				this.commit({ ...registry, revision: 1 }, current, check, raw)
			else {
				if (this.deps.settings.read() !== raw)
					throw new Error('主题记录已被其他会话修改，请重新加载')
				this.assertPrepared(current, check)
				this.stored = raw
				const installed = registry.installed.map(item => current.installedRecord?.id === item.id && current.installedRecord.archiveSha256 === item.archiveSha256 ? current.installedRecord : item)
				this.registry = { ...registry, installed }
				this.update({
					current: current.presentation,
					installed: structuredCopy(installed),
					revision: registry.revision,
					canUndo: registry.previous !== null,
					phase: 'ready',
					readOnly: false,
					error: cleanupError,
				})
			}
		})
	}
	importBytes(input: Uint8Array): Promise<boolean> {
		// Synchronous admission bounds queued archive copies independently of UI.
		// A rejected busy call does not replace the admitted operation's intent.
		if (this.importAdmitted) return Promise.resolve(false)
		// Bound before copying; caller must also use the bounded document reader.
		if (
			!(input instanceof Uint8Array) ||
			input.length > themePackageLimits.archiveBytes
		)
			return this.work('validating', async (check) => {
				await this.clearPreview()
				check()
				throw new Error('主题文件超过20MiB上限')
			})
		this.importAdmitted = true
		let bytes: Uint8Array | null = new Uint8Array(input)
		const admitted = this.work('validating', async (check, signal) => {
			this.writable()
			await this.clearPreview()
			check()
			const value = await validateThemePackage(
				bytes!,
				this.deps.host,
				this.deps.decoder,
				{ signal },
			)
			check()
			let stage: ThemeStage | null = null
			try {
				stage = await this.deps.files.createStage()
				check()
				this.update({ phase: 'preparing-preview' })
				const leaf = `${value.manifest.id}/${value.snapshot.package.archiveSha256}`
				await this.deps.files.writeStage(
					stage,
					`${leaf}/archive.melotheme`,
					bytes!,
				)
				check()
				for (const file of value.files) {
					await this.deps.files.writeStage(
						stage,
						`${leaf}/${file.path}`,
						file.bytes,
					)
					check()
				}
				value.files = []
				bytes = null
				const disk = await this.verifyDisk(
					stage,
					value.snapshot.package,
					check,
					signal,
				)
				const prepared = await this.prepare(
					disk.presentation,
					'preview',
					check,
					signal,
				)
				this.assertPrepared(prepared, check)
				this.previewData = { stage, record: disk.record }
				this.update({ preview: prepared.presentation, phase: 'preview' })
				stage = null
			} finally {
				if (stage) await this.cleanup(stage)
			}
		}).finally(() => {
			bytes = null
			this.importAdmitted = false
		})
		// cancel() drains this finalizer too, so awaiting it opens the import slot.
		this.tail = admitted.catch(() => undefined)
		return admitted
	}
	applyPreview(): Promise<boolean> {
		return this.work('applying', async (check, signal) => {
			const registry = this.writable(),
				preview = this.previewData
			if (!preview) throw new Error('请先完成主题预览')
			try {
				const record = preview.record
				await this.verifyDisk(preview.stage, record, check, signal)
				check()
				await this.deps.files.publish(
					preview.stage,
					record.id,
					record.archiveSha256,
				)
				check()
				const disk = await this.verifyDisk('installed', record, check, signal)
				check()
				const prepared = await this.prepare(
					disk.presentation,
					'activate',
					check,
					signal,
				)
				const installed = disk.record
				const records = registry.installed.filter(
					(item) =>
						item.id !== installed.id ||
						item.archiveSha256 !== installed.archiveSha256,
				)
				records.push(installed)
				if (records.length > 200) throw new Error('主题安装数量超限')
				this.commit(
					{
						...registry,
						revision: registry.revision + 1,
						installed: records,
						active: disk.presentation.selection,
						previous: previousFor(registry, disk.presentation.selection),
					},
					prepared,
					check,
				)
			} finally {
				await this.clearPreview()
			}
		})
	}
	activateInstalled(id: string, archiveSha256: string): Promise<boolean> {
		return this.activate({ kind: 'package', id, archiveSha256 })
	}
	removeInstalled(id: string, archiveSha256: string): Promise<boolean> {
		return this.work('applying', async (check) => {
			const registry = this.writable()
			if (!this.deps.files.removeInstalled) throw new Error('当前版本不支持删除主题文件，请更新应用')
			const matches = (value: ThemeSelection | null) => value?.kind === 'package' && value.id === id && value.archiveSha256 === archiveSha256
			if (!registry.installed.some(item => item.id === id && item.archiveSha256 === archiveSha256)) throw new Error('主题未安装')
			await this.clearPreview()
			check()
			const current = matches(registry.active) ? preparedBuiltin('modern') : { presentation: this.state.current, lease: { assertCurrent() {} } }
			const token = `${Date.now().toString(36)}-${registry.revision}-${Math.random().toString(36).slice(2)}`
			this.commit({ ...registry, revision: registry.revision + 1,
				installed: registry.installed.filter(item => item.id !== id || item.archiveSha256 !== archiveSha256),
				active: current.presentation.selection,
				previous: matches(registry.previous) ? null : registry.previous,
				pendingRemoval: [{ id, archiveSha256, token }],
			}, current, check)
			try { await this.deps.files.removeInstalled(id, archiveSha256, token) }
			catch { throw new Error('主题已移除，但本地文件清理失败。请重新加载主题以重试清理。') }
			check()
			this.commit({ ...this.registry!, revision: this.registry!.revision + 1, pendingRemoval: [] }, current, check)
		})
	}
	activateBuiltin(key: ThemeKey): Promise<boolean> {
		return this.activate({ kind: 'builtin', key })
	}
	private activate(pointer: ThemeSelection): Promise<boolean> {
		return this.work('applying', async (check, signal) => {
			const registry = this.writable()
			await this.clearPreview()
			check()
			const current = await this.resolve(
				selection(pointer),
				registry,
				check,
				signal,
				'activate',
			)
			check()
			this.commit(
				{
					...registry,
					revision: registry.revision + 1,
					active: current.presentation.selection,
					previous: previousFor(registry, current.presentation.selection),
				},
				current,
				check,
			)
		})
	}
	undo(): Promise<boolean> {
		return this.work('applying', async (check, signal) => {
			const registry = this.writable()
			await this.clearPreview()
			check()
			if (!registry.previous) throw new Error('没有可撤销的主题')
			const current = await this.resolve(
				registry.previous,
				registry,
				check,
				signal,
				'activate',
			)
			check()
			this.commit(
				{
					...registry,
					revision: registry.revision + 1,
					active: current.presentation.selection,
					previous: registry.active,
				},
				current,
				check,
			)
		})
	}
	cancel(): Promise<boolean> {
		return this.work('ready', async (check) => {
			await this.clearPreview()
			check()
			this.update({ phase: this.registry ? 'ready' : 'idle' })
		})
	}
}
