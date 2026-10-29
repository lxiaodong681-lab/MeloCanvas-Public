import assert from 'node:assert/strict'
import test from 'node:test'

import type { ImportTaskEntry } from '../core/import-types'
import { importMatchScore } from '../import-matching'

const entry = {
	originalMetadata: {
		track: { name: '风的来信', ar: [{ name: '原神' }], dt: 220000 },
	},
} as unknown as ImportTaskEntry
void test('automatic matching rejects unrelated titles, wrong editions and excessive durations', () => {
	assert.ok(
		importMatchScore(entry, 'netease', '原神六周年主题曲《风的来信》', 218) > 0,
	)
	assert.equal(importMatchScore(entry, 'netease', '云原神', 220), -1)
	assert.equal(importMatchScore(entry, 'netease', '风的来信 翻唱', 220), -1)
	assert.equal(importMatchScore(entry, 'netease', '风的来信 伴奏', 220), -1)
	assert.equal(importMatchScore(entry, 'netease', '风的来信', 900), -1)
})
