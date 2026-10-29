import assert from 'node:assert/strict'
import test from 'node:test'

import { lyricCandidateEvidence, lyricVersionConflict, loadedLyricVersionText } from '../online-lyrics-ranking'

void test('short cuts cannot silently match full recordings even when duration metadata agrees', () => {
	for (const edition of ['Game Size', 'TV Size', 'Short Ver.', 'ゲームサイズ']) {
		const candidate = {
			source: 'netease' as const, remoteId: 1,
			title: `恋ひ恋ふ縁 (${edition})`, artist: 'Famishin', duration: 90,
		}
		const track = { sourceId: 'video:1', title: '恋ひ恋ふ縁 (Full Ver.)', durationSeconds: 90 }
		assert.equal(lyricCandidateEvidence(candidate, track).eligible, false, edition)
		assert.equal(lyricCandidateEvidence(candidate, { ...track, title: candidate.title }).eligible, true)
	}
})

void test('OP alone does not establish Game Size; video quality labels do not imply a full song', () => {
	assert.equal(lyricVersionConflict('千恋万花 OP 恋ひ恋ふ縁', '恋ひ恋ふ縁 (Game Size)'), true)
	assert.equal(lyricVersionConflict('恋ひ恋ふ縁 Full HD 1080P', '恋ひ恋ふ縁'), false)
	assert.equal(lyricVersionConflict('恋ひ恋ふ縁 (完整版)', '恋ひ恋ふ縁 (Full Ver.)'), false)
})

void test('edition evidence in a loaded lyric title is retained for version review', () => {
	const title = loadedLyricVersionText('恋ひ恋ふ縁', '', ['恋ひ恋ふ縁 (Game Size)', '仅用于测试'])
	assert.equal(lyricVersionConflict('恋ひ恋ふ縁 (Full Ver.)', title), true)
})
