import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { builtInThemes, type ResolvedTheme } from '../core/theme'
import { canSortSearch } from '../search-order'
import { musicResults } from '../search-session'
import type { SearchPageProps } from '../search-ui'

export interface ViewNode {
	type: string
	props: Record<string, unknown>
	children: unknown[]
}
export const react = {
	createElement: (
		type: string | ((props: Record<string, unknown>) => ViewNode),
		props: Record<string, unknown> | null,
		...children: unknown[]
	): ViewNode =>
		typeof type === 'function'
			? type({ ...props, children })
			: { type, props: props ?? {}, children },
	Fragment: 'Fragment',
}
export function compile(sourceText: string) {
	return ts.transpileModule(sourceText, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.CommonJS,
			jsx: ts.JsxEmit.React,
		},
	}).outputText
}
export function nodes(value: unknown): ViewNode[] {
	if (Array.isArray(value)) return value.flatMap(nodes)
	if (
		value &&
		typeof value === 'object' &&
		'type' in value &&
		'children' in value
	)
		return [value as ViewNode, ...nodes((value as ViewNode).children)]
	return []
}
export function text(value: unknown): string {
	if (Array.isArray(value)) return value.map(text).join('')
	if (value && typeof value === 'object' && 'children' in value)
		return text((value as ViewNode).children)
	return typeof value === 'string' || typeof value === 'number'
		? String(value)
		: ''
}
export function node(
	value: unknown,
	predicate: (node: ViewNode) => boolean,
): ViewNode {
	const found = nodes(value).find(predicate)
	assert.ok(found, 'Expected component node is absent')
	return found
}
export function byLabel(value: unknown, label: string) {
	return node(value, (item) => item.props.accessibilityLabel === label)
}

const ui = ts.createSourceFile(
	'ui.tsx',
	readFileSync(new URL('../ui.tsx', import.meta.url), 'utf8'),
	ts.ScriptTarget.Latest,
	true,
	ts.ScriptKind.TSX,
)
const shapeNode = ui.statements.find(
	(statement) =>
		ts.isFunctionDeclaration(statement) && statement.name?.text === 'shape',
)
assert.ok(shapeNode)
// Use the real host shape function rather than duplicating its theme mapping.
export const shape = runInNewContext(
	compile(shapeNode.getText(ui)) + '\nexports.shape',
	{ exports: {} },
) as (variant: ResolvedTheme['components']['input']) => Record<string, unknown>
const source = compile(
	readFileSync(new URL('../search-ui.tsx', import.meta.url), 'utf8'),
)

/** Execute the actual component; RN host views are inspectable records, with no React effects/network. */
export function renderSearchPage(
	props: SearchPageProps,
	theme = builtInThemes.modern,
): ViewNode {
	const output: { SearchPage?: (props: SearchPageProps) => ViewNode } = {}
	const requireModule = (name: string): unknown => {
		if (name === 'react') return { __esModule: true, default: react, ...react }
		if (name === 'react-native')
			return {
				Modal: 'Modal',
				Pressable: 'Pressable',
				ScrollView: 'ScrollView',
				TextInput: 'TextInput',
				View: 'View',
				StyleSheet: { create: (value: unknown) => value },
			}
		if (name === './search-order') return { canSortSearch }
		if (name === './search-session') return { musicResults }
		if (name === './creator-remote-ui')
			return { CreatorSearchResults: 'CreatorSearchResults' }
		if (name === './page-title') return { PageTitle: 'PageTitle' }
		if (name === './core/theme-layout') return {}
		if (name === './search-query-controls' || name === './theme-dialog') {
			const controls = {}
			runInNewContext(
				compile(
					readFileSync(
						new URL(`../${name.slice(2)}.tsx`, import.meta.url),
						'utf8',
					),
				),
				{
					exports: controls,
					require: requireModule,
				},
			)
			return controls
		}
		if (name === './ui')
			return {
				Button: 'Button',
				ControlTarget: 'Pressable',
				Icon: 'Icon',
				State: 'State',
				T: 'T',
				shape,
				useTheme: () => theme,
				useThemeRendering: () => null,
			}
		throw new Error(`Unexpected presentation dependency ${name}`)
	}
	runInNewContext(source, { exports: output, require: requireModule })
	assert.ok(output.SearchPage)
	return output.SearchPage(props)
}
