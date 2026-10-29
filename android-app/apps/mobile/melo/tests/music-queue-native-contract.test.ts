import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Source-wiring regressions supplement native helper tests; they do not prove
// Media3 playback continuity on a device. The override supports sparse checkouts.
const root =
	process.env.MELO_NATIVE_ANDROID_SOURCE_ROOT ??
	fileURLToPath(
		new URL('../../../../packages/orpheus/android/src', import.meta.url),
	)
const service = readFileSync(
	join(root, 'main/java/expo/modules/orpheus/service/OrpheusMusicService.kt'),
	'utf8',
)
const section = (start: string, end: string) => {
	const from = service.indexOf(start)
	const to = service.indexOf(end, from + start.length)
	assert.ok(from >= 0 && to > from)
	return service.slice(from, to)
}
const ordered = (source: string, ...calls: string[]) => {
	let previous = -1
	for (const call of calls) {
		const index = source.indexOf(call)
		assert.ok(
			index >= 0 && index > previous,
			`Missing or out-of-order native call: ${call}`,
		)
		previous = index
	}
}
void test('native queue undo retires on repeat, every playlist mutation and shuffle changes', () => {
	const transition = section(
		'override fun onMediaItemTransition(',
		'override fun onShuffleModeEnabledChanged(',
	)
	assert.match(
		transition,
		/if \(reason == Player\.MEDIA_ITEM_TRANSITION_REASON_REPEAT\) musicQueueRemoval\.queueChanged\(\)/,
	)
	assert.match(
		transition,
		/musicQueueRemoval\.observe\(playbackMode, fm != null \|\| auditionReturn != null,/,
	)
	assert.match(
		section(
			'override fun onShuffleModeEnabledChanged(',
			'override fun onTimelineChanged(',
		),
		/musicQueueRemoval\.queueChanged\(\)/,
	)
	assert.match(
		section('override fun onTimelineChanged(', 'override fun onEvents('),
		/if \(reason == Player\.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED\) musicQueueRemoval\.queueChanged\(\)/,
	)
	assert.match(
		section('private fun commitPlaybackState(', 'fun appendFm('),
		/musicQueueRemoval\.queueChanged\(\)/,
	)
})
void test('native removal validates before touching queue and saves the original native item only after removal', () => {
	const removal = section(
		'fun removeMusicQueueEntry(',
		'fun undoMusicQueueRemoval(',
	)
	ordered(
		removal,
		'MusicQueueNext.plan(',
		'current.getMediaItemAt(index)',
		'current.removeMediaItem(index)',
		'musicQueueRemoval.remember(',
	)
	assert.match(
		removal,
		/current\.currentMediaItem\?\.mediaId == expectedCurrentEntryId/,
	)
	assert.doesNotMatch(
		removal,
		/\.(play|pause|seekTo|setMediaItems|clearMediaItems|delete)\s*\(/,
	)
})
void test('native undo restores saved payload at its original index and consumes the receipt', () => {
	const undo = section(
		'fun undoMusicQueueRemoval(',
		'private fun musicQueueUndoSnapshot(',
	)
	ordered(
		undo,
		'musicQueueRemoval.requireUndo(',
		'current.addMediaItem(saved.index, saved.payload)',
		'musicQueueRemoval.queueChanged()',
	)
	assert.doesNotMatch(
		undo,
		/\.(play|pause|seekTo|setMediaItems|clearMediaItems|delete)\s*\(/,
	)
})
