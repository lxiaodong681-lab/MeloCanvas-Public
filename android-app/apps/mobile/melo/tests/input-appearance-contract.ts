import assert from 'node:assert/strict'
import type { ResolvedTheme } from '../core/theme'
import { controlNodes } from './theme-control-fixture'

/** Admit only semantic input colors in historical trees; all other props stay strict. */
export function migrateInputAppearance(current: unknown, expected: unknown, theme: ResolvedTheme) {
	const actualInputs = controlNodes(current).filter(node => node.type === 'TextInput')
	const oldInputs = controlNodes(expected).filter(node => node.type === 'TextInput')
	assert.equal(actualInputs.length, oldInputs.length)
	for (const [index, before] of oldInputs.entries()) {
		for (const [key, fallback] of Object.entries({
			placeholderTextColor: theme.tokens.text.secondary,
			selectionColor: theme.tokens.action.primary,
			cursorColor: theme.tokens.action.primary,
		})) {
			const color = before.props[key] ?? fallback
			assert.equal(actualInputs[index].props[key], color)
			before.props[key] = color
		}
	}
}
