import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import { builtInThemes } from '../core/theme'
import { cosmosTheme } from '../core/theme-appearance'
import { PlaybackProgress } from '../playback-progress'
import { activeLyric, parseLyrics } from '../lyrics'
import { controlFixture, controlNodes, legacyControlPackage, type ControlNode } from './theme-control-fixture'

const noop = () => {}

void test('lyric subscription snapshot stays equal within a verse and changes immediately on forward and backward seeks', () => {
	const source = readFileSync(new URL('../lyrics-ui.tsx', import.meta.url), 'utf8')
	const ast = ts.createSourceFile('lyrics-ui.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
	const declarations = new Map<string, ts.VariableDeclaration>()
	const visit = (node: ts.Node) => {
		if (ts.isVariableDeclaration(node)) declarations.set(node.name.getText(ast), node)
		ts.forEachChild(node, visit)
	}
	visit(ast)
	const binding = declarations.get('active')!.initializer as ts.CallExpression
	assert.equal(binding.expression.getText(ast), 'useSyncExternalStore')
	assert.equal(binding.arguments[0].getText(ast), 'progress?.subscribe ?? noProgressSubscription')
	assert.equal(binding.arguments[1].getText(ast), 'activeSnapshot')
	const progress = new PlaybackProgress()
	const parsed = parseLyrics('[00:00]第一句\n[00:10]第二句\n[00:20]第三句')
	const snapshot = runInNewContext(declarations.get('activeSnapshot')!.initializer!.getText(ast), {
		useCallback: (callback: () => number) => callback, activeLyric,
		parsed, progress, fallbackPosition: 0, lyricOffset: 0,
	}) as () => number
	let changes = 0, previous = snapshot()
	const unsubscribe = progress.subscribe(() => {
		const next = snapshot()
		if (!Object.is(previous, next)) changes++
		previous = next
	})
	for (let i = 1; i < 100; i++) progress.update(i / 10, 30)
	assert.equal(changes, 0, 'subsecond updates do not invalidate lyric content')
	progress.update(10, 30)
	assert.equal(previous, 1)
	progress.update(25, 30)
	assert.equal(previous, 2)
	progress.update(2, 30)
	assert.equal(previous, 0)
	assert.equal(changes, 3)
	unsubscribe()
})

void test('builtin, dark and package player shells do not subscribe to progress; leaf controls still follow live ticks', async () => {
	const pack = await legacyControlPackage()
	for (const theme of [...Object.values(builtInThemes), cosmosTheme, pack.adapted.theme]) {
		for (const [file, name] of [['host-controls', 'MiniPlayerControls'], ['music-ui', 'MusicPlayer'], ['listening-ui', 'ListeningPlayer']] as const) {
			let inShell = false, reads = 0
			const progress = new PlaybackProgress()
			const seeks: number[] = []
			const f = controlFixture({}, {
				'./usePlaybackProgress': { usePlaybackProgress: (store: PlaybackProgress | undefined, position: number, duration: number) => {
					assert.equal(inShell, false, `${name} must not subscribe the whole themed page`)
					reads++
					return store ? store.getSnapshot() : { position, duration }
				} },
			})
			const Actual = f.load(file)[name] as (props: Record<string, unknown>) => unknown
			const Shell = (props: Record<string, unknown>) => {
				inShell = true
				try { return Actual(props) } finally { inShell = false }
			}
			const source = { id: 'bilibili:BV1234567890:42', bvid: 'BV1234567890', cid: 42, originalTitle: '测试音频', title: '测试音频', duration: 100 }
			const props = {
				progress, position: 1, duration: 100, mode: 'music', title: '测试音频', artist: '测试',
				playing: true, buffering: false, switching: false, error: '', source, parts: [], partsLoading: false, partsError: '',
				bottomInset: 0, speed: 1, reducedMotion: true, canReturnMusic: false,
				onOpen: noop, onToggle: noop, onQueue: noop, onClose: noop, onTheme: noop, onSource: noop, onCreator: noop,
				onSeek: (value: number) => seeks.push(value), onSpeed: noop, onPart: noop, onRetryParts: noop, onRetry: noop,
				onReturnMusic: noop, onCancel: noop, onSleepTimer: noop, onRefreshSleepTimer: async () => {},
				library: { setting: () => null, setSetting: noop }, current: null, isLiked: () => false,
				onLike: noop, onNotice: noop, onNotificationSettings: noop, onFm: noop, fmMessage: '', notifications: false,
				player: { track: { id: 'track', sourceId: source.id, title: '测试音频', duration: 100 },
					progress, position: 1, duration: 100, playing: true, seek: noop, playbackOrder: 'sequence',
					toggle: noop, previous: noop, next: noop, cyclePlaybackOrder: noop },
			}
			const render = () => f.render(f.element(f.load('ui').ThemeRendererProvider as ControlNode['type'], {
				theme, adapted: theme === pack.adapted.theme ? pack.adapted : null,
				allowedImageUris: pack.allowedImageUris, reducedMotion: true,
			}, f.element(Shell, props)))
			try {
				for (const position of [0, 25, 70, 100]) {
					progress.update(position, 100)
					const tree = render()
					if (name === 'MiniPlayerControls') {
						const bar = controlNodes(tree).find((node) => node.props.testID === 'mini-player-progress')!
						assert.equal(f.flatten(bar.props.style).width, `${position}%`)
					} else {
						const bar = controlNodes(tree).find((node) => node.props.accessibilityRole === 'adjustable')!
						assert.equal((bar.props.accessibilityValue as { now: number }).now, position)
					}
				}
				assert.ok(reads >= 4)
				if (name === 'ListeningPlayer') {
					const tree = render()
					progress.update(40, 100)
					const forward = controlNodes(tree).find((node) => node.props.accessibilityLabel === '前进15秒')!
					assert.ok(forward)
					;(forward.props.onPress as () => void)()
					assert.deepEqual(seeks, [55], 'seek reads current position even without a shell rerender')
				}
			} finally { f.unmount() }
		}
	}
})
