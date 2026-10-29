import type { ResolvedTheme } from '../core/theme'
import type { AdaptedPackageTheme } from '../core/theme-package-adapter'
import { CreatorSearchSession } from '../creator-search-session'
import { canSortSearch } from '../search-order'
import { musicResults, SearchSession } from '../search-session'
import type { SearchPageProps } from '../search-ui'

import {
	controlFixture,
	controlNodes,
	type ControlNode,
} from './theme-control-fixture'

export const component = (value: unknown) => value as ControlNode['type']
export function searchHost(original?: string) {
	const deps: Record<string, unknown> = {
		'./search-session': { musicResults },
		'./search-order': { canSortSearch },
		'./page-title': { PageTitle: 'PageTitle' },
		'./creator-remote-ui': { CreatorSearchResults: 'CreatorSearchResults' },
	}
	const f = controlFixture(original ? { 'search-ui': original } : {}, deps)
	const ui = f.load('ui')
	deps['./search-query-controls'] = f.load('search-query-controls')
	const page = component(f.load('search-ui').SearchPage)
	return {
		...f,
		page(props: SearchPageProps) {
			return f.element(page, props as unknown as Record<string, unknown>)
		},
		query(props: Record<string, unknown>) {
			return f.element(
				component(
					(deps['./search-query-controls'] as Record<string, unknown>)
						.SearchQueryControls,
				),
				props,
			)
		},
		builtin(child: unknown, theme: ResolvedTheme) {
			return f.element(component(ui.ThemeProvider), { value: theme }, child)
		},
		pack(child: unknown, adapted: AdaptedPackageTheme) {
			return f.element(
				component(ui.PackageThemeProvider),
				{ adapted, allowedImageUris: [], reducedMotion: true },
				child,
			)
		},
	}
}
export function searchProps(
	overrides: Partial<SearchPageProps> = {},
): SearchPageProps {
	const session = new SearchSession(async () => ({ items: [], more: false }))
	const creator = new CreatorSearchSession(async (_query, page) => ({
		items: [],
		page,
		more: false,
	}))
	return {
		query: '旧 render query',
		filter: 'all',
		search: {
			...session.getSnapshot(),
			retry: session.retry,
			setOrder: session.setOrder,
			loadMore: session.loadMore,
		},
		creatorSearch: { state: creator.getSnapshot(), session: creator },
		onQueryChange: () => {},
		onSubmit: () => {},
		onFilterChange: () => {},
		onOpenCreator: () => {},
		renderRow: () => null,
		...overrides,
	}
}
export function native(tree: unknown, id: string) {
	const found = controlNodes(tree).find(
		(node) => node.props.testID === id || node.props.accessibilityLabel === id,
	)
	if (!found) throw new Error(`Missing native node ${id}`)
	return found
}
export function measure(node: ControlNode, width: number) {
	;(node.props.onLayout as (event: unknown) => void)({
		nativeEvent: { layout: { width } },
	})
}
export function inputPath(value: unknown, prefix = 'root'): string | null {
	if (Array.isArray(value)) {
		for (const [index, child] of value.entries()) {
			const found = inputPath(child, `${prefix}/${index}`)
			if (found) return found
		}
		return null
	}
	if (!value || typeof value !== 'object' || !('type' in value)) return null
	const node = value as ControlNode,
		path = `${prefix}/${typeof node.type === 'string' ? node.type : 'component'}:${node.key ?? ''}`
	return node.type === 'TextInput' ? path : inputPath(node.children, path)
}
export function normalize(
	f: ReturnType<typeof searchHost>,
	value: unknown,
): unknown {
	if (Array.isArray(value))
		return Array.from(value, (child) => normalize(f, child))
	if (typeof value === 'function') return '<callback>'
	if (!value || typeof value !== 'object') return value
	if ('type' in value) {
		const node = value as ControlNode
		return {
			type: node.type,
			props: normalize(
				f,
				Object.fromEntries(
					Object.entries(node.props)
						.filter(([key, v]) => key !== 'children' && v !== undefined)
						.map(([key, v]) => [
							key,
							key === 'style'
								? f.flatten(typeof v === 'function' ? v({ pressed: false }) : v)
								: v,
						]),
				),
			),
			children: normalize(f, node.children),
		}
	}
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.map(([key, v]) => [key, normalize(f, v)]),
	)
}
