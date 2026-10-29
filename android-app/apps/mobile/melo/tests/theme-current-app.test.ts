import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { builtInThemes } from '../core/theme'
import type { ThemePresentation } from '../core/theme-install-types'
import {
	ThemeWorkshopSession,
	themeWorkshopBusy,
} from '../theme-workshop-session'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

const source = ts.createSourceFile(
	'App.tsx',
	readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'),
	ts.ScriptTarget.Latest,
	true,
	ts.ScriptKind.TSX,
)
const declarations = new Map<string, ts.Expression>()
const providers: ts.JsxOpeningElement[] = [],
	probes: ts.JsxSelfClosingElement[] = []
function visit(node: ts.Node) {
	if (
		ts.isVariableDeclaration(node) &&
		ts.isIdentifier(node.name) &&
		node.initializer
	)
		declarations.set(node.name.text, node.initializer)
	if (
		ts.isJsxOpeningElement(node) &&
		node.tagName.getText(source) === 'ThemeRendererProvider'
	)
		providers.push(node)
	if (
		ts.isJsxSelfClosingElement(node) &&
		node.tagName.getText(source) === 'ThemeLayoutProbe'
	)
		probes.push(node)
	ts.forEachChild(node, visit)
}
visit(source)
function attribute(
	node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
	key: string,
) {
	const attr = node.attributes.properties.find(
		(value) => ts.isJsxAttribute(value) && value.name.getText(source) === key,
	) as ts.JsxAttribute | undefined
	return attr && attr.initializer && ts.isJsxExpression(attr.initializer)
		? attr.initializer.expression?.getText(source)
		: undefined
}
function expression(value: string, scope: Record<string, unknown>) {
	const out: { read?: (scope: Record<string, unknown>) => unknown } = {}
	runInNewContext(
		ts.transpileModule(
			`exports.read=({workshop,currentDisplay,theme,reduced,systemReduced})=>(${value})`,
			{ compilerOptions: { module: ts.ModuleKind.CommonJS } },
		).outputText,
		{ exports: out },
	)
	return out.read!(scope)
}

void test('actual App theme bindings render effective properties while original selection and stable provider remain authoritative', () => {
	assert.equal(providers.length, 1)
	const provider = providers[0]
	assert.equal(attribute(provider, 'key'), undefined)
	assert.equal(
		attribute(provider, 'adapted'),
		'currentDisplay.presentation.adapted',
	)
	assert.equal(
		attribute(provider, 'allowedImageUris'),
		'currentDisplay.presentation.allowedImageUris',
	)
	assert.equal(probes.length, 2)
	assert.deepEqual(
		probes.map((probe) => attribute(probe, 'gate')),
		['candidateLayoutGate', 'currentLayoutGate'],
	)
	assert.deepEqual(
		probes.map((probe) => attribute(probe, 'bounds')),
		['themeRootBounds', 'themeRootBounds'],
	)
	assert.match(
		declarations.get('currentLayoutGate')!.getText(source),
		/useMemo\(\(\) => new ThemeLayoutGate\(\), \[\]\)/,
	)
	assert.equal(
		declarations.get('workshop')!.getText(source),
		'useThemeWorkshop(library, prepareWithCurrentRestore, true)',
	)
	assert.match(
		declarations.get('prepareWithCurrentRestore')!.getText(source),
		/withCurrentLayoutRestore\(preparePresentation\)/,
	)
	const selected = {
		kind: 'package',
		id: 'example.kept',
		archiveSha256: 'a'.repeat(64),
	}
	const workshop = {
		state: {
			current: {
				selection: selected,
				theme: builtInThemes.anime,
				adapted: { retained: 'selected' },
				allowedImageUris: ['selected-uri'],
			},
		},
	}
	const currentDisplay = {
		presentation: {
			selection: { kind: 'builtin', key: 'modern' },
			theme: builtInThemes.modern,
			adapted: null,
			allowedImageUris: [],
		},
	}
	const scope: Record<string, unknown> = {
		workshop,
		currentDisplay,
		reduced: false,
		systemReduced: false,
	}
	scope.theme = expression(declarations.get('theme')!.getText(source), scope)
	assert.equal(
		expression(attribute(provider, 'theme')!, scope),
		builtInThemes.modern,
	)
	assert.equal(expression(attribute(provider, 'adapted')!, scope), null)
	assert.deepEqual(
		expression(attribute(provider, 'allowedImageUris')!, scope),
		[],
	)
	assert.equal(
		expression(declarations.get('selection')!.getText(source), scope),
		selected,
	)
})

void test('actual App keeps both layout probes outside the startup content gate', () => {
	const boundaries: ts.JsxElement[] = []
	function collect(node: ts.Node) {
		if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'StartupContent')
			boundaries.push(node)
		ts.forEachChild(node, collect)
	}
	collect(source)
	assert.equal(boundaries.length, 1)
	const boundary = boundaries[0]
	assert.equal(attribute(boundary.openingElement, 'ready'), '!workshop.state.loading && !currentDisplay.pending')
	assert.equal(attribute(boundary.openingElement, 'mode'), 'appearance.mode')
	for (const probe of probes) {
		assert.ok(probe.pos < boundary.pos)
		assert.equal(probe.parent, boundary.parent)
	}
	assert.match(boundary.getText(source), /<Backdrop/)
	assert.match(boundary.getText(source), /<Modal/)
})

const component = (value: unknown) => value as ControlNode['type']
const text = (value: unknown): string =>
	Array.isArray(value)
		? value.map(text).join('')
		: value && typeof value === 'object' && 'children' in value
			? text((value as ControlNode).children)
			: typeof value === 'string'
				? value
				: ''
void test('actual workshop panel explains temporary modern and automatic restoration while retaining selected package identity and causing no action', () => {
	let creates = 0
	const session = new ThemeWorkshopSession({
		fallback: () => 'anime',
		create: async () => {
			creates++
			throw new Error('render must not initialize installer')
		},
		pick: async () => null,
		read: async () => new Uint8Array(),
	})
	const selected: ThemePresentation = {
		selection: {
			kind: 'package',
			id: 'example.kept',
			archiveSha256: 'a'.repeat(64),
		},
		theme: { ...builtInThemes.anime, name: '已选包' },
		adapted: null,
		packageMetadata: null,
		allowedImageUris: [],
	}
	const modern: ThemePresentation = {
		selection: { kind: 'builtin', key: 'modern' },
		theme: builtInThemes.modern,
		adapted: null,
		packageMetadata: null,
		allowedImageUris: [],
	}
	const h = controlFixture(
		{},
		{
			'./theme-workshop-session': { themeWorkshopBusy },
			'./theme-preview': { ThemeReferencePreview: 'ThemeReferencePreview' },
			'./theme-author-ui': { ThemeAuthorEntry: 'ThemeAuthorEntry' },
			'./bilibili-theme-ui': { BilibiliThemeEntry: 'BilibiliThemeEntry' },
		},
	)
	const Panel = component(h.load('theme-package-panel').ThemePackagePanel)
	const state = { ...session.getSnapshot(), loading: false, current: selected }
	try {
		const view = h.render(
			h.element(Panel, {
				state,
				session,
				reducedMotion: true,
				display: {
					presentation: modern,
					temporaryModern: true,
					reason: '当前窗口暂不适配，适配后会自动恢复。',
				},
			}),
		)
		assert.match(text(view), /已选主题：已选包/)
		assert.match(text(view), /当前临时显示：内置现代主题/)
		assert.match(text(view), /适配后会自动恢复/)
		assert.equal(
			controlNodes(view).filter(
				(node) => node.props.testID === 'theme-current-layout-notice',
			).length,
			1,
		)
		const restored = h.render(
			h.element(Panel, {
				state,
				session,
				reducedMotion: true,
				display: {
					presentation: selected,
					temporaryModern: false,
					reason: null,
				},
			}),
		)
		assert.match(text(restored), /当前主题：已选包/)
		assert.equal(text(restored).includes('当前临时显示'), false)
		assert.equal(creates, 0)
	} finally {
		h.unmount()
		session.stop()
	}
})
