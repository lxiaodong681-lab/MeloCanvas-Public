import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

const text = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const tree = ts.createSourceFile(
	'App.tsx',
	text,
	ts.ScriptTarget.Latest,
	true,
	ts.ScriptKind.TSX,
)
let callback = ''
function visit(node: ts.Node) {
	if (
		ts.isVariableDeclaration(node) &&
		node.name.getText(tree) === 'closePlayer' &&
		node.initializer &&
		ts.isCallExpression(node.initializer)
	)
		callback = node.initializer.arguments[0].getText(tree)
	ts.forEachChild(node, visit)
}
visit(tree)
assert.ok(callback)
const compiled = ts.transpileModule(`(${callback})`, {
	compilerOptions: {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.None,
	},
}).outputText

for (const success of [true, false]) {
	void test(`audition close ${success ? 'restores and dismisses' : 'retains exit panel for retry'} after returning review ownership`, async () => {
		const events: string[] = []
		const close = runInNewContext(compiled, {
			player: {
				auditionId: 'candidate-a',
				track: { id: 'candidate-entry', sourceId: 'candidate-source' },
				endCandidateAudition: async (id: string) => {
					assert.equal(id, 'candidate-a')
					events.push('restore')
					return success
				},
			},
			imports: {
				session: {
					resumeFromPlayer(source: string, entry: string) {
						assert.equal(source, 'candidate-source')
						assert.equal(entry, 'candidate-entry')
						events.push('review')
					},
				},
			},
			setFullPlayer(value: boolean) {
				assert.equal(value, false)
				events.push('dismiss')
			},
		}) as () => Promise<void>
		await close()
		assert.deepEqual(
			events,
			success ? ['review', 'restore', 'dismiss'] : ['review', 'restore'],
		)
	})
}

void test('same-service remount exposes exit without needing a stale full-player or review route', () => {
	assert.match(text, /if \(fullPlayer \|\| player\.auditionId\)/)
	assert.match(text, /\{player\.auditionId \? \(/)
	assert.match(readFileSync(new URL('../candidate-audition-ui.tsx', import.meta.url), 'utf8'), /结束试听，恢复原播放/)
	assert.match(
		text,
		/!player\.auditionId && player\.mode === 'music' \? player\.track : null/,
	)
})
