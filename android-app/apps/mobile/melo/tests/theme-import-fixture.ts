import { readFileSync } from 'node:fs'

import type { BilibiliImportState } from '../bilibili-import-session'
import * as mixedTypes from '../core/import-mixed-types'
import { originalVideoBvid } from '../core/import-mixed-validation'
import type { ImportCommitReceipt } from '../core/import-playlist-types'
import type {
	ImportProvider,
	ImportTaskDetail,
	ImportTaskEntry,
} from '../core/import-types'
import * as queue from '../core/queue'
import { builtInThemes } from '../core/theme'
import type { AdaptedPackageTheme } from '../core/theme-package-adapter'
import * as display from '../import-display'
import type { ImportState } from '../import-session'
import { parseListeningVideo } from '../listening-source'
import * as playlistSelection from '../playlist-selection'
import type { PlaylistState } from '../playlist-session'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

export const baseline = 'c62f733e970674506cb5daaf44fba78baecbb30f'
export const names = ['playlist-ui', 'import-ui', 'bilibili-import-ui'] as const
export const component = (value: unknown) => value as ControlNode['type']
export const video = parseListeningVideo(
	{
		bvid: 'BV1vT411i7ET',
		title: '真实版本',
		owner: { mid: 88, name: '原UP' },
		pic: 'https://example.invalid/art',
		videos: 2,
		pages: [11, 22].map((cid, index) => ({
			cid,
			page: index + 1,
			part: `版本${index + 1}`,
			duration: 200,
		})),
	},
	'BV1vT411i7ET',
)
export function task(
	provider: ImportProvider = 'netease',
	count = 3,
): ImportTaskDetail {
	return {
		taskId: 'task',
		taskVersion: 1,
		provider,
		originalPlaylistId: '123',
		revision: 1,
		createdAt: 1,
		updatedAt: 1,
		entryCount: count,
		originalMetadata:
			provider === 'bilibili'
				? {
						completeness: 'complete',
						reportedTotal: count,
						observedCount: count,
						pages: [{ page: 1, info: { id: 123, title: '原收藏夹' } }],
					}
				: {
						playlist: { name: '原歌单' },
						directory: {
							status: 'complete',
							expectedCount: count,
							readMetadataCount: count,
						},
					},
		entries: Array.from({ length: count }, (_, index): ImportTaskEntry => ({
			entryId: `e${index}`,
			originalEntryId: index === 1 ? 'B' : 'A',
			originalPosition: index,
			originalMetadata:
				provider === 'bilibili'
					? {
							media: {
								id: index + 1,
								type: 2,
								bvid: video.bvid,
								title: index === 1 ? '原B' : '原A',
								upper: { name: '原UP' },
								duration: 200,
							},
							observed: { bvid: video.bvid },
						}
					: {
							track: {
								name: index === 1 ? '原B' : '原A',
								ar: [{ name: '原歌手' }],
								al: { name: '原专辑' },
								dt: 200000,
							},
						},
			selected: index === 0,
			review: { state: 'pending', candidates: [], confirmation: null },
			reviewedAt: null,
			retries: [],
		})),
		commits: [],
	}
}
export function receipt(): ImportCommitReceipt {
	return {
		commitId: 'commit',
		taskId: 'task',
		request: {
			commitId: 'commit',
			expectedRevision: 1,
			target: { kind: 'create', playlistId: 'saved', name: '副本' },
			duplicatePolicy: 'keep-all',
			itemIds: [{ entryId: 'e0', itemId: 'i0' }],
		},
		playlistId: 'saved',
		taskRevision: 2,
		playlistUpdatedAt: 2,
		committedAt: 2,
		results: [
			{
				entryId: 'e0',
				requestedItemId: 'i0',
				itemId: 'i0',
				sourceId: null,
				outcome: 'added',
			},
		],
	}
}
export function importState(change: Partial<ImportState> = {}): ImportState {
	return {
		batch: null,
		route: 'home',
		provider: null,
		url: '',
		tasks: [],
		task: null,
		entryId: null,
		taskPage: 0,
		taskFilter: 'all',
		binding: null,
		reading: false,
		unsaved: null,
		query: '',
		candidates: [],
		searchPage: 0,
		searchMore: false,
		searching: false,
		searchError: '',
		video: null,
		videoBusy: false,
		selectedCid: null,
		playlists: [],
		command: null,
		receipt: null,
		busy: false,
		suspended: false,
		playbackBusy: false,
		error: '',
		notice: '',
		...change,
	}
}
export function biliState(
	change: Partial<BilibiliImportState> = {},
): BilibiliImportState {
	return {
		route: 'folders',
		mid: '123',
		folderAccess: 'public',
		folderAccount: null,
		mineAvailable: false,
		folders: null,
		favoriteId: '',
		task: null,
		entryId: null,
		video: null,
		selectedCid: null,
		playlists: [],
		command: null,
		receipt: null,
		busy: false,
		error: '',
		notice: '',
		binding: null,
		organizationItem: null,
		organizationCommand: null,
		organizationReceipt: null,
		page: 0,
		transportBusy: false,
		quick: null,
		collection: null,
		playback: { busy: false, suspended: false, error: '' },
		...change,
	}
}
export function mixedTask(count = 3): mixedTypes.MixedImportTaskDetail {
	return {
		...task('bilibili', count),
		contentReviews: [],
		history: [],
		organizations: [],
	}
}
export function playlistState(
	change: Partial<PlaylistState> = {},
): PlaylistState {
	return {
		playlists: [],
		currentId: null,
		detail: null,
		sources: new Map(),
		detailQuery: '',
		detailViewToken: 0,
		detailFilter: 'all',
		editing: false,
		selectedItemIds: [],
		nameForm: null,
		coverForm: null,
		picker: null,
		targetSources: null,
		deleting: false,
		undoAvailable: false,
		error: '',
		notice: '',
		...change,
	}
}
export function packageTheme(): AdaptedPackageTheme {
	return {
		theme: structuredClone(builtInThemes.modern),
		mode: 'light',
		retained: {
			buttonMinTouchDp: 96,
			controlRowLayout: {
				minTouchDp: 96,
				compactMinTouchDp: 72,
				narrowFallback: 'host-single-row',
			},
			lyricTokens: { active: '#111111', inactive: '#444444' },
		},
		renderingResponsibilities: [
			'local-image-uris',
			'button-min-touch-dp',
			'lyric-tokens',
			'motion-duration-and-reduced-motion',
			'explicit-color-mode',
		],
	}
}
/** Real page/shared TSX; native RAF, Keyboard/Linking and business actions are explicit recording ports. */
export function importHost(originals: Record<string, string> = {}) {
	const frames = new Map<number, () => void>(),
		calls: unknown[][] = []
	let frame = 0,
		state: Record<string, unknown> = {}
	const platform = {
		requestAnimationFrame: (callback: () => void) => {
			frames.set(++frame, callback)
			return frame
		},
		cancelAnimationFrame: (id: number) => frames.delete(id),
	}
	const prefix =
		"import {requestAnimationFrame,cancelAnimationFrame} from './test-platform';\n"
	const sources = Object.fromEntries(
		names.map((name) => [
			name,
			(name === 'playlist-ui' ? '' : prefix) +
				(originals[name] ??
					readFileSync(new URL(`../${name}.tsx`, import.meta.url), 'utf8')),
		]),
	)
	const dependencies: Record<string, unknown> = {
		'./core/queue': queue,
		'./playlist-selection': playlistSelection,
		'./import-display': display,
		'./core/import-mixed-types': mixedTypes,
		'./test-platform': platform,
	}
	const f = controlFixture(sources, dependencies),
		ui = f.load('ui')
	dependencies['./theme-input'] = f.load('theme-input')
	// Loaded shared controls retain their own real context/dimension ports.
	dependencies['react-native'] = {
		useWindowDimensions: () => ({ ...f.viewport }),
		View: 'View',
		ScrollView: 'ScrollView',
		FlatList: 'FlatList',
		TextInput: 'TextInput',
		Pressable: 'Pressable',
		Modal: 'Modal',
		KeyboardAvoidingView: 'KeyboardAvoidingView',
		Platform: { OS: 'android' },
		StyleSheet: {
			flatten: f.flatten,
			create: (value: unknown) => value,
			absoluteFill: {
				position: 'absolute',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
			},
		},
		Keyboard: { dismiss: () => calls.push(['keyboard']) },
		Linking: {
			openURL: async (url: string) => {
				calls.push(['url', url])
			},
		},
	}
	const modules = Object.assign({}, ...names.map((name) => f.load(name)))
	const session = new Proxy(
		{},
		{
			get: (_target, key) => {
				if (key === 'getSnapshot') return () => state
				if (key === 'getDetailScroll')
					return () => ({ itemId: null, index: 0, offset: 0 })
				if (key === 'scrollOffset') return () => 0
				if (key === 'newId' || key === 'newPlaylistId') return () => 'new-local'
				const current = state as unknown as ImportState & BilibiliImportState
				if (key === 'selected')
					return () =>
						current.task?.entries.filter((entry) => entry.selected) ?? []
				if (key === 'kind')
					return (id: string) =>
						current.task?.contentReviews?.find(
							(review) => review.entryId === id,
						)?.kind ?? 'unknown'
				if (key === 'processed')
					return () =>
						new Set(
							current.task?.history.flatMap((event) =>
								event.receipt.results.map((result) => result.entryId),
							) ?? [],
						)
				if (key === 'originalBvid')
					return () => {
						const entry = current.task?.entries.find(
							(item) => item.entryId === current.entryId,
						)
						return entry ? originalVideoBvid(entry) : null
					}
				if (key === 'createTaskFilterAction')
					return () => (filter: string) => {
						calls.push(['setTaskFilter', filter])
						return true
					}
				if (key === 'createOriginalQueryAction')
					return () => () => calls.push(['fillOriginalQuery'])
				if (key === 'createOriginalVideoAction')
					return (bvid: string) => () => calls.push(['openOriginalVideo', bvid])
				if (key === 'selectedSource')
					return () =>
						current.video?.parts.find(
							(part) => part.source.cid === current.selectedCid,
						)?.source ?? null
				return (...args: unknown[]) => calls.push([String(key), ...args])
			},
		},
	)
	function page(name: string, value: object) {
		state = value as Record<string, unknown>
		return f.element(component(modules[name]), {
			state,
			session,
			bottomInset: 12,
			reducedMotion: true,
			onSearch: () => calls.push(['search']),
			onPreview: (source?: unknown) => calls.push(['preview', source]),
			onHub: () => calls.push(['hub']),
			onPress: () => calls.push(['entry']),
			onPlaylist: (id: string) => calls.push(['playlist', id]),
			onPlayPlaylist: (id: string) => calls.push(['play-playlist', id]),
			onLibrary: (bucket: string) => calls.push(['library', bucket]),
			onOpenPlaylist: (id: string) => calls.push(['playlist', id]),
			onBilibili: () => calls.push(['bilibili']),
			onBilibiliTask: (id: string) => calls.push(['bilibili-task', id]),
			playbackBusy: false,
			playbackError: null,
		})
	}
	return { ...f, ui, calls, frames, page }
}
export type ImportHost = ReturnType<typeof importHost>
export function text(value: unknown): string {
	return Array.isArray(value)
		? value.map(text).join('')
		: value && typeof value === 'object' && 'children' in value
			? text((value as ControlNode).children)
			: typeof value === 'string' || typeof value === 'number'
				? String(value)
				: ''
}
export function controls(tree: unknown) {
	return controlNodes(tree).filter((node) => node.type === 'Pressable')
}
export function label(tree: unknown, name: string) {
	const node = controlNodes(tree).find(
		(value) =>
			(value.type === 'Pressable' || value.type === 'TextInput') &&
			(value.props.accessibilityLabel ?? text(value.children)) === name,
	)
	if (!node) throw new Error(`Missing ${name}`)
	return node
}
export function press(tree: unknown, name: string) {
	const node = label(tree, name)
	if (node.props.disabled) throw new Error(`Disabled ${name}`)
	;(node.props.onPress as () => void)()
}
export function flat(h: ImportHost, node: ControlNode) {
	return h.flatten(
		typeof node.props.style === 'function'
			? node.props.style({ pressed: false })
			: node.props.style,
	)
}
export function measurements(tree: unknown) {
	return controlNodes(tree).filter(
		(node) =>
			typeof node.props.onLayout === 'function' &&
			(String(node.key).includes('[') || typeof node.key === 'number'),
	)
}
export function measure(node: ControlNode, width: number) {
	;(node.props.onLayout as (event: unknown) => void)({
		nativeEvent: { layout: { width } },
	})
}
export function settle(h: ImportHost, value: unknown, width = 400) {
	let tree = h.render(value)
	for (let i = 0; i < 3; i++) {
		for (const node of measurements(tree)) measure(node, width)
		tree = h.render(value)
	}
	return tree
}
export function responsive(
	h: ImportHost,
	name: string,
	state: object,
	adapted = packageTheme(),
) {
	return h.element(
		component(h.ui.PackageThemeProvider),
		{ adapted, allowedImageUris: [], reducedMotion: true },
		h.page(name, state),
	)
}
export function normalize(h: ImportHost, value: unknown): unknown {
	if (Array.isArray(value))
		return Array.from(value, (child) => normalize(h, child))
	if (typeof value === 'function') return '<callback>'
	if (!value || typeof value !== 'object') return value
	if ('type' in value) {
		const node = value as ControlNode
		return {
			type: node.type,
			props: normalize(
				h,
				Object.fromEntries(
					Object.entries(node.props)
						.filter(([key, v]) => key !== 'children' && v !== undefined)
						.map(([key, v]) => [key, key === 'style' ? flat(h, node) : v]),
				),
			),
			children: normalize(h, node.children),
		}
	}
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.map(([key, v]) => [key, normalize(h, v)]),
	)
}
