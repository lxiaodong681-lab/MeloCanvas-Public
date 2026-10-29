import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { TestContext } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { BilibiliContentScopeReader } from '../core/bilibili-content-scope'
import { CreatorPostCache } from '../core/creator-post-cache'
import { CreatorStore } from '../core/creators'
import { Library, migrate, type Database } from '../core/database'
import type { ContentKind } from '../core/import-mixed-types'
import { ImportStore } from '../core/imports'
import type { CreatorPostCandidate } from '../creator-api'
import {
	resolveCreatorPost,
	verifyCreatorPost,
} from '../creator-post-selection'
import { CreatorRemoteSession } from '../creator-remote-session'
import { CreatorSession } from '../creator-session'
import * as parts from '../listening-parts-state'
import * as selection from '../listening-selection'
import { parseListeningVideo, type ListeningVideo } from '../listening-source'
import { PlaybackIntent, playMusicIntent } from '../playback-intent'
import type { useCreators } from '../useCreators'
import type { useListening } from '../useListening'

import { preparationPort } from './playback-preparation-fixture'

export const post = (index: number, mid = '88'): CreatorPostCandidate => ({
	bvid: `BV${String(index).padStart(10, '0')}`,
	title: `原投稿${index}`,
	queryCreatorMid: mid,
	ownerMid: '99',
	duration: 100,
	publishedAt: 1700000000000 + index,
	artwork: 'https://example.invalid/cover.png',
})
export function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
export const flush = async () => {
	for (let index = 0; index < 60; index++) await Promise.resolve()
}
export function compile(source: string) {
	return ts.transpileModule(source, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.CommonJS,
		},
	}).outputText
}
export function fixture(t: TestContext) {
	const raw = new DatabaseSync(':memory:')
	t.after(() => raw.close())
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, values) => raw.prepare(sql).run(...values),
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
		getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
			raw.prepare(sql).all(...values) as T[],
	}
	migrate(db)
	const scopes = new BilibiliContentScopeReader(db),
		cache = new CreatorPostCache(db),
		imports = new ImportStore(db),
		creators = new CreatorStore(db),
		library = new Library(db)
	const profile = creators.saveCreator({
		source: 'bilibili',
		mid: '88',
		name: '查询UP',
		fetchedAt: 1,
	})
	const api = {
		profile: async () => profile,
		posts: async (_mid: string, page: number) => ({
			items: [] as CreatorPostCandidate[],
			page,
			total: 0,
			more: false,
		}),
	}
	let task = 0
	return {
		raw,
		db,
		scopes,
		cache,
		imports,
		creators,
		library,
		profile,
		api,
		remote: () =>
			new CreatorRemoteSession(
				api,
				() => {},
				cache,
				scopes,
				() => 100,
			),
		save: (items: CreatorPostCandidate[], total = items.length) =>
			cache.savePage(
				'88',
				{ items, page: 1, total, more: total > items.length },
				100,
				cache.load('88')?.revision ?? null,
			),
		classify: (values: { bvid: string; kind: ContentKind }[]) => {
			const taskId = `classification-${++task}`
			imports.createDirectory({
				taskId,
				provider: 'bilibili',
				originalPlaylistId: taskId,
				taskVersion: 1,
				originalMetadata: {},
				entries: values.map((value, index) => ({
					entryId: `e${index}`,
					originalEntryId: value.bvid,
					originalPosition: index,
					originalMetadata: {
						media: { bvid: value.bvid },
						observed: { bvid: value.bvid },
					},
				})),
			})
			for (const [index, value] of values.entries())
				imports.reviewContent(taskId, `e${index}`, { kind: value.kind }, index)
			return taskId
		},
	}
}
export type Fixture = ReturnType<typeof fixture>
export function video(candidate = post(1)): ListeningVideo {
	return parseListeningVideo(
		{
			bvid: candidate.bvid,
			title: 'view核验标题',
			pic: candidate.artwork,
			owner: { mid: 99, name: '真实上传者' },
			pages: [{ cid: 11, page: 1, part: 'P1', duration: 100 }],
		},
		candidate.bvid,
	)
}

/** Actual useCreators subscription and actual App declaration, not copied routing. */
export function appFixture(
	f: Fixture,
	load: () => Promise<ListeningVideo> = async () => video(),
) {
	const cleanups: (() => void)[] = [],
		output: { useCreators?: typeof useCreators } = {}
	runInNewContext(
		compile(
			readFileSync(new URL('../useCreators.ts', import.meta.url), 'utf8'),
		),
		{
			exports: output,
			require: (name: string) => {
				if (name === 'react')
					return {
						useMemo: (create: () => unknown) => create(),
						useSyncExternalStore: (_subscribe: unknown, get: () => unknown) =>
							get(),
						useEffect: (create: () => () => void) => cleanups.push(create()),
					}
				if (name === './creator-api')
					return { creatorProfile: f.api.profile, creatorPosts: f.api.posts }
				if (name === './creator-session') return { CreatorSession }
				if (name === './creator-remote-session') return { CreatorRemoteSession }
				throw new Error(name)
			},
		},
	)
	const creators = output.useCreators!(f.creators, f.library, f.cache, f.scopes)
	creators.session.openSummary(f.profile)
	const intent = new PlaybackIntent(),
		activated: string[] = [],
		presented: boolean[] = [],
		alerts: {
			buttons: { text: string; onPress: () => void }[]
			options: { onDismiss: () => void }
		}[] = []
	const player = {
		...preparationPort(),
		mode: 'music' as const,
		playing: true,
		playSource: async () => {
			activated.push('music')
			return true
		},
		playListening: async () => {
			activated.push('listening')
			return true
		},
	}
	const listeningExports: { useListening?: typeof useListening } = {}
	runInNewContext(
		compile(
			readFileSync(new URL('../useListening.ts', import.meta.url), 'utf8'),
		),
		{
			exports: listeningExports,
			Error,
			require: (name: string) => {
				if (name === 'react')
					return {
						useEffect: () => {},
						useRef: (value: unknown) => ({ current: value }),
						useState: (value: unknown) => [value, () => {}],
					}
				if (name === 'react-native')
					return {
						Alert: {
							alert: (
								_title: string,
								_message: string,
								buttons: (typeof alerts)[number]['buttons'],
								options: (typeof alerts)[number]['options'],
							) => alerts.push({ buttons, options }),
						},
					}
				if (name === './listening-parts-state') return parts
				if (name === './listening-selection') return selection
				if (name === './listening-source')
					return { listeningSourceDetails: load }
				throw new Error(name)
			},
		},
	)
	const listening = listeningExports.useListening!(
		player,
		null,
		() => assert.fail('App presents'),
		() => assert.fail('App handles errors'),
		intent,
	)
	const app = ts.createSourceFile(
		'App.tsx',
		readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	)
	let declaration = ''
	const visit = (node: ts.Node) => {
		if (
			ts.isFunctionDeclaration(node) &&
			node.name?.text === 'playCreatorSource'
		)
			declaration = node.getText(app)
		ts.forEachChild(node, visit)
	}
	visit(app)
	assert.ok(declaration)
	let pending: Promise<boolean> = Promise.resolve(false)
	const original = creators.session.presentPlayback.bind(creators.session)
	creators.session.presentPlayback = (...args) => {
		pending = original(...args)
		return pending
	}
	const render = () =>
		runInNewContext(compile(`${declaration}\nplayCreatorSource`), {
			creators: { ...creators, remoteState: creators.remote.getSnapshot() },
			playbackIntent: intent,
			playMusicIntent,
			player,
			listening,
			resolveSource: async (source: unknown) => source,
			resolveCreatorPost: (
				candidate: CreatorPostCandidate,
				signal: AbortSignal,
			) => resolveCreatorPost(candidate, signal, load),
			verifyCreatorPost,
			setSourceRequestBv: () => {},
			fullPlayer: false,
			creatorPlayerReturn: { current: false },
			setFullPlayer: (value: boolean) => presented.push(value),
			Error,
		}) as (source: CreatorPostCandidate, mode: 'music' | 'listening') => void
	return {
		creators,
		player,
		intent,
		alerts,
		activated,
		presented,
		listening,
		render,
		pending: () => pending,
		dispose: () => cleanups.forEach((cleanup) => cleanup()),
	}
}
