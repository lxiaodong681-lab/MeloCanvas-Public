import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import * as lyrics from '../lyrics'

import { compile } from './search-page-fixture'

void test('picker imports only bounded UTF-8 LRC/TXT and removes only owned temporary copies', async () => {
	let name = '原创.lrc',
		raw = '[00:01]原创测试词',
		size = 20,
		parent = 'cache/DocumentPicker',
		removed = 0,
		canceled = false
	const output: {
		pickLyrics?: () => Promise<{ filename: string; raw: string } | null>
	} = {}
	runInNewContext(
		compile(
			readFileSync(new URL('../lyrics-mobile.ts', import.meta.url), 'utf8'),
		),
		{
			exports: output,
			require: (dependency: string) => {
				if (dependency === './lyrics') return lyrics
				if (dependency === 'expo-document-picker')
					return {
						getDocumentAsync: async () => ({
							canceled,
							assets: [{ name, uri: 'picked' }],
						}),
					}
				if (dependency === 'expo-file-system')
					return {
						Paths: { cache: 'cache' },
						Directory: class {
							uri: string
							constructor(root: string, leaf: string) {
								this.uri = `${root}/${leaf}`
							}
						},
						File: class {
							size = size
							exists = true
							parentDirectory = { uri: parent }
							text() {
								return Promise.resolve(raw)
							}
							delete() {
								removed++
							}
						},
					}
				throw new Error(dependency)
			},
		},
	)
	assert.ok(output.pickLyrics)
	assert.equal((await output.pickLyrics())?.raw, raw)
	assert.equal(removed, 1)
	name = 'wrong.json'
	await assert.rejects(output.pickLyrics(), /请选择/)
	assert.equal(removed, 2)
	name = '原创.txt'
	size = 262145
	await assert.rejects(output.pickLyrics(), /256 KiB/)
	size = 20
	raw = '\uFFFD'
	await assert.rejects(output.pickLyrics(), /UTF-8/)
	parent = 'user/documents'
	await assert.rejects(output.pickLyrics())
	assert.equal(removed, 4)
	canceled = true
	assert.equal(await output.pickLyrics(), null)
})
