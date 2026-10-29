import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import { builtInThemes } from '../core/theme'

import {
	compile,
	nodes,
	react,
	text,
	type ViewNode,
} from './search-page-fixture'

function harness(saveResult: boolean | Error = true, restoreError?: Error) {
	const states: unknown[] = []
	let index = 0
	const calls: string[] = []
	const selected = {
		token: 'synthetic',
		catalogueJson: '{}',
		full: false,
		audioFiles: 0,
		themeFiles: 0,
		coverFiles: 0,
		bytes: 10,
	}
	const output: {
		LibraryBackupEntry?: (props: { onRestored: () => void }) => ViewNode
	} = {}
	const dependencies = (name: string): unknown => {
		if (name === 'react')
			return {
				__esModule: true,
				default: react,
				...react,
				useState: (initial: unknown) => {
					const slot = index++
					if (!(slot in states)) states[slot] = initial
					return [
						states[slot],
						(value: unknown) => {
							states[slot] = value
						},
					]
				},
				useRef: (initial: unknown) => {
					const slot = index++
					if (!(slot in states)) states[slot] = { current: initial }
					return states[slot]
				},
			}
		if (name === 'react-native-safe-area-context')
			return {
				useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
			}
		if (name === 'react-native')
			return { Modal: 'Modal', ScrollView: 'ScrollView', View: 'View', Pressable: 'Pressable' }
		if (name === './theme-dialog') {
			const dialog = {}
			runInNewContext(compile(readFileSync(new URL('../theme-dialog.tsx', import.meta.url), 'utf8')), { exports: dialog, require: dependencies })
			return dialog
		}
		if (name === './settings-layout') return { SettingsRow: 'SettingsRow', PageHeader: 'PageHeader', SettingsGroup: 'SettingsGroup' }
		if (name === './ui')
			return {
				Button: 'Button',
				Card: 'Card',
				T: 'T',
				useTheme: () => builtInThemes.modern,
			}
		if (name === './library-backup-mobile')
			return {
				canUndoLibraryBackup: () => calls.includes('replace'),
				undoLastLibraryBackup: () => {
					calls.push('undo')
				},
				previewLibraryBackupMerge: () => ({
					inserted: 1,
					keptExisting: 2,
					skippedGroups: 1,
				}),
				chooseLibraryBackup: async () => {
					calls.push('choose')
					return selected
				},
				discardLibraryBackup: async () => {
					calls.push('discard')
				},
				previewLibraryBackup: () => ({
					playlists: 1,
					liked: 2,
					pendingItems: 1,
					localReferences: 1,
				}),
				restoreLibraryBackup: async (_backup: unknown, mode: string) => {
					calls.push(mode === 'replace' ? 'replace' : 'restore')
					if (restoreError) throw restoreError
					return { inserted: 1, keptExisting: 2, skippedGroups: 1 }
				},
				saveLibraryBackup: async (full: boolean) => {
					calls.push(full ? 'save-full' : 'save-light')
					if (saveResult instanceof Error) throw saveResult
					return saveResult
				},
				shareLibraryBackup: async (full: boolean) => {
					calls.push(full ? 'export-full' : 'export-light')
				},
			}
		throw new Error(`Unexpected dependency ${name}`)
	}
	runInNewContext(
		compile(
			readFileSync(
				new URL('../library-backup-ui.tsx', import.meta.url),
				'utf8',
			),
		),
		{ exports: output, require: dependencies, Error },
	)
	const render = () => {
		index = 0
		return output.LibraryBackupEntry!({
			onRestored: () => calls.push('refresh'),
		})
	}
	const click = async (label: string) => {
		const button = nodes(render()).find(
			(node) => (node.type === 'Button' && text(node) === label) || (node.type === 'SettingsRow' && node.props.label === label),
		)
		assert.ok(button, label)
		assert.equal(!!button.props.disabled, false)
		;(button.props.onPress as () => void)()
		await new Promise((resolve) => setImmediate(resolve))
	}
	const back = async () => { (nodes(render()).find(n => n.type === 'PageHeader')!.props.onBack as () => void)(); await new Promise(resolve => setImmediate(resolve)) };
	return { calls, render, click, back }
}
void test('actual backup UI exposes honest scopes and requires a separate merge confirmation after choosing', async () => {
	const f = harness()
	await f.click('音乐库备份与恢复')
	await f.click('备份说明')
	assert.match(
		text(f.render()),
		/不含登录信息、账号凭据、活动播放队列、在线下载缓存、仅 Wi-Fi 开关、推荐反馈和原生最近播放记录/,
	)
	await f.back()
	await f.click('创建备份')
	await f.click('含本地文件')
	assert.match(text(f.render()), /包括自定义歌单封面/)
	await f.back()
	await f.click('从备份恢复')
	await f.click('选择备份，先查看内容')
	assert.deepEqual(f.calls, ['choose'])
	assert.match(text(f.render()), /但不含音频文件/)
	await f.click('确认合并，不覆盖当前内容')
	assert.deepEqual(f.calls, ['choose', 'restore', 'refresh'])
	assert.match(text(f.render()), /合并完成/)
})
void test('cancelling preview disposes only staging and does not restore or play', async () => {
	const f = harness()
	await f.click('音乐库备份与恢复')
	await f.click('从备份恢复')
	await f.click('选择备份，先查看内容')
	await f.click('取消恢复')
	assert.deepEqual(f.calls, ['choose', 'discard'])
})
void test('light and full exports pass distinct modes; share return is not reported as confirmed saved backup', async () => {
	const f = harness()
	await f.click('音乐库备份与恢复')
	await f.click('创建备份')
	await f.click('分享轻量备份')
	await f.click('含本地文件')
	await f.click('分享完整备份')
	assert.deepEqual(f.calls, ['export-light', 'export-full'])
	assert.match(text(f.render()), /请确认文件实际保存到应用以外的位置/)
})

void test('replacement and undo each require their own explicit confirmation', async () => {
	const f = harness()
	await f.click('音乐库备份与恢复')
	await f.click('从备份恢复')
	await f.click('选择备份，先查看内容')
	await f.click('选择替换恢复…')
	assert.deepEqual(f.calls, ['choose'])
	const confirmation = nodes(f.render()).findLast(n => n.type === 'Modal')!
	assert.ok(confirmation)
	;(confirmation.props.onRequestClose as () => void)()
	assert.deepEqual(f.calls, ['choose'])
	assert.doesNotMatch(text(f.render()), /确认替换，并保存撤销点/)
	await f.click('选择替换恢复…')
	assert.match(
		text(f.render()),
		/不会删除已有音频文件、本地音频条目、主题文件或正在播放队列/,
	)
	await f.click('确认替换，并保存撤销点')
	assert.deepEqual(f.calls, ['choose', 'replace', 'refresh'])
	await f.back()
	await f.click('撤销上次替换恢复…')
	assert.deepEqual(f.calls, ['choose', 'replace', 'refresh'])
	await f.click('确认撤销替换')
	assert.deepEqual(f.calls, ['choose', 'replace', 'refresh', 'undo', 'refresh'])
})
void test('backup return stays outside scrolling content and reserves safe-area space', () => {
	const tree = harness().render()
	const scroll = nodes(tree).find((n) => n.type === 'ScrollView')!
	assert.ok(
		!nodes(scroll).some((n) => n.type === 'PageHeader' && n.props.title === '备份与恢复'),
	)
	const shell = nodes(tree).find(
		(n) =>
			n.type === 'View' &&
			(n.props.style as { paddingTop?: number })?.paddingTop === 24,
	)
	assert.ok(shell)
	assert.equal(
		(shell.props.style as { paddingBottom: number }).paddingBottom,
		24,
	)
	assert.ok(nodes(shell).some((n) => n.type === 'PageHeader' && n.props.title === '备份与恢复'))
})

void test('replacement failure remains visible in the confirmation and can be cancelled without retrying', async () => {
	const f = harness(true, new Error('合成恢复失败'))
	await f.click('音乐库备份与恢复')
	await f.click('从备份恢复')
	await f.click('选择备份，先查看内容')
	await f.click('选择替换恢复…')
	await f.click('确认替换，并保存撤销点')
	const modal = nodes(f.render()).findLast(n => n.type === 'Modal')!
	assert.match(text(modal), /合成恢复失败/)
	assert.deepEqual(f.calls, ['choose', 'replace'])
	;(modal.props.onRequestClose as () => void)()
	assert.doesNotMatch(text(f.render()), /确认替换，并保存撤销点/)
	assert.deepEqual(f.calls, ['choose', 'replace'])
})

void test('light and full save use system save route and only true reports saved', async () => {
	const f = harness()
	await f.click('音乐库备份与恢复')
	await f.click('创建备份')
	await f.click('保存轻量备份到文件')
	await f.click('含本地文件')
	await f.click('保存完整备份到文件')
	assert.deepEqual(f.calls, ['save-light', 'save-full'])
	assert.match(text(f.render()), /备份已保存到你选择的位置/)
})
void test('save cancellation never reports success', async () => {
	const f = harness(false)
	await f.click('创建备份')
	await f.click('保存轻量备份到文件')
	assert.match(text(f.render()), /已取消保存，未导出备份/)
	assert.doesNotMatch(text(f.render()), /备份已保存到你选择的位置/)
})
void test('save provider failure is displayed without success or restore', async () => {
	const f = harness(new Error('备份保存失败；所选位置可能留有不完整文件。'))
	await f.click('创建备份')
	await f.click('含本地文件')
	await f.click('保存完整备份到文件')
	assert.deepEqual(f.calls, ['save-full'])
	assert.match(text(f.render()), /可能留有不完整文件/)
	assert.doesNotMatch(text(f.render()), /备份已保存到你选择的位置/)
})

void test('backup hub separates export and restore; back disposes preview without changing the library', async () => {
 const f=harness(); await f.click('音乐库备份与恢复');
 assert.ok(!nodes(f.render()).some(n=>n.type==='Button'));
 await f.click('创建备份'); assert.doesNotMatch(text(f.render()),/选择备份，先查看内容/);
 await f.back(); await f.click('从备份恢复'); assert.doesNotMatch(text(f.render()),/保存轻量备份到文件/);
 await f.click('选择备份，先查看内容'); await f.back();
 assert.deepEqual(f.calls,['choose','discard']); assert.ok(!nodes(f.render()).some(n=>n.type==='Button'));
});
