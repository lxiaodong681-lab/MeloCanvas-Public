import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

import { BilibiliContentScopeReader } from '../core/bilibili-content-scope'
import { CreatorPostCache } from '../core/creator-post-cache'
import { CreatorStore } from '../core/creators'
import { Library, migrate, type Database } from '../core/database'
import { FollowingFeedStore } from '../core/following-feed'
import { ImportStore } from '../core/imports'
import { ListeningLibrary } from '../core/listening'
import { LocalAudioStore } from '../core/local-audio'
import { sourceId, type Source } from '../core/model'
import { MusicPreferencesStore } from '../core/music-preferences'
import { PlaylistStore } from '../core/playlists'
import { playlistEntryId } from '../core/queue'
import { RecommendationStore } from '../core/recommendations'
import { SessionStore } from '../core/sessions'
import { VideoCatalog } from '../core/video-catalog'
import { VideoSaves } from '../core/video-saves'

const text = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const tree = ts.createSourceFile(
	'App.tsx',
	text,
	ts.ScriptTarget.Latest,
	true,
	ts.ScriptKind.TSX,
)
const app = tree.statements.find(
	(node) => ts.isFunctionDeclaration(node) && node.name?.text === 'App',
)
assert.ok(app && ts.isFunctionDeclaration(app) && app.body)
const statement = app.body.statements[0]
assert.ok(ts.isVariableStatement(statement))
const initializer = statement.declarationList.declarations[0].initializer
assert.ok(
	initializer &&
		ts.isCallExpression(initializer) &&
		initializer.expression.getText(tree) === 'useState',
)
const factory = ts.transpile(
	`const actualFactory = ${initializer.arguments[0].getText(tree)}; actualFactory()`,
	{ target: ts.ScriptTarget.ES2022 },
)

type AppData = {
	library: Library | null
	playlistStore: PlaylistStore | null
	sessionStore: SessionStore | null
	error: string
}
function initialize(
	openDatabaseSync: (
		name: string,
		options?: { useNewConnection?: boolean },
	) => Database,
): AppData {
	return runInNewContext(factory, {
		openDatabaseSync,
		migrate,
		Library,
		ListeningLibrary,
		LocalAudioStore,
		MusicPreferencesStore,
		SessionStore,
		PlaylistStore,
		CreatorStore,
		CreatorPostCache,
		BilibiliContentScopeReader,
		FollowingFeedStore,
		ImportStore,
		VideoCatalog,
		VideoSaves,
		RecommendationStore,
		Date,
		Error,
	}) as AppData
}
function connection(raw: DatabaseSync): Database {
	return {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, values) => raw.prepare(sql).run(...values),
		getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
			raw.prepare(sql).all(...values) as T[],
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
	}
}
const source: Source = {
	id: sourceId('BV1vT411i7ET', 123),
	bvid: 'BV1vT411i7ET',
	cid: 123,
	originalTitle: '保留的音源',
	uploader: '原上传者',
	uploaderId: 88,
	performer: null,
	artwork: '',
	duration: 300,
	domain: 'music',
	audioAvailability: 'unknown',
}
function fixture(run: (file: string, raws: DatabaseSync[]) => void) {
	const dir = mkdtempSync(join(tmpdir(), 'melo-app-lifetime-'))
	assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep))
	assert.ok(basename(dir).startsWith('melo-app-lifetime-'))
	const raws: DatabaseSync[] = []
	try {
		run(join(dir, 'melocanvas.db'), raws)
	} finally {
		for (const raw of raws) {
			try {
				raw.close()
			} catch {
				/* already released by test */
			}
		}
		rmSync(dir, { recursive: true })
	}
}

void test('actual App initializer requests independent handles; an old wrapper release cannot invalidate the new App connection', () => {
	fixture((file, raws) => {
		const options: ({ useNewConnection?: boolean } | undefined)[] = []
		let cached: Database | undefined
		const open = (name: string, value?: { useNewConnection?: boolean }) => {
			assert.equal(name, 'melocanvas.db')
			options.push(value)
			// Expo's cache admission is verified independently from its actual Kotlin bodies.
			if (!value?.useNewConnection && cached) return cached
			const raw = new DatabaseSync(file)
			raws.push(raw)
			const db = connection(raw)
			if (!value?.useNewConnection) cached = db
			return db
		}
		const first = initialize(open)
		assert.equal(first.error, '')
		assert.ok(first.library)
		first.library.save(source)
		const second = initialize(open)
		assert.equal(second.error, '')
		assert.ok(second.library)
		raws[0].close() // controlled release, not a claim that Node reproduced Android GC
		assert.equal(
			second.library.get(source.id)?.originalTitle,
			source.originalTitle,
		)
		assert.equal(raws.length, 2)
		assert.ok(options.every((value) => value?.useNewConnection === true))
	})
})

void test('two actual App initializations retain the same file data, duplicate item identities and session position; writes still roll back', () => {
	fixture((file, raws) => {
		const open = () => {
			const raw = new DatabaseSync(file)
			raws.push(raw)
			return connection(raw)
		}
		const first = initialize(open)
		assert.ok(first.library && first.playlistStore && first.sessionStore)
		first.library.setLiked(source, true)
		first.library.setSetting('lifetime-evidence', 'preserve-exactly')
		first.playlistStore.create('manual', '原歌单')
		const sourceB = { ...source, id: sourceId(source.bvid, 124), cid: 124 }
		const entries = [
			{ itemId: 'a', source },
			{ itemId: 'b', source: sourceB },
			{ itemId: 'a2', source },
		]
		first.playlistStore.append('manual', entries, 'keep-all')
		first.sessionStore.saveSession({
			mode: 'music',
			entries: entries.map((entry) => ({
				entryId: playlistEntryId(entry.itemId),
				sourceId: entry.source.id,
			})),
			currentEntryId: playlistEntryId('a2'),
			currentSourceId: source.id,
			positionSeconds: 59.942,
			speed: 1,
			updatedAt: 123,
		})
		const before = first.playlistStore.get('manual')
		const sessionBefore = first.sessionStore.getSession('music')
		const second = initialize(open)
		assert.ok(second.library && second.playlistStore && second.sessionStore)
		assert.deepEqual(second.playlistStore.get('manual'), before)
		assert.equal(
			second.library.setting('lifetime-evidence'),
			'preserve-exactly',
		)
		assert.equal(second.library.likes().length, 1)
		assert.equal(
			second.sessionStore.getSession('music')?.positionSeconds,
			59.942,
		)
		assert.deepEqual(second.sessionStore.getSession('music'), sessionBefore)
		raws[1].exec(
			"CREATE TRIGGER deny_lifetime_item BEFORE INSERT ON playlist_items BEGIN SELECT RAISE(ABORT, 'test atomic failure'); END",
		)
		assert.throws(
			() =>
				second.playlistStore!.append(
					'manual',
					[{ itemId: 'failed', source }],
					'keep-all',
				),
			/test atomic failure/,
		)
		assert.deepEqual(second.playlistStore.get('manual'), before)
		assert.deepEqual(first.playlistStore.get('manual'), before)
	})
})

void test('actual App initialization failure remains an error and cannot close or reset an existing App connection', () => {
	fixture((file, raws) => {
		const raw = new DatabaseSync(file)
		raws.push(raw)
		const first = initialize(() => connection(raw))
		assert.ok(first.library)
		first.library.save(source)
		const failed = initialize(() => {
			throw new Error('cannot open new handle')
		})
		assert.equal(failed.library, null)
		assert.equal(failed.error, 'cannot open new handle')
		assert.equal(first.library.get(source.id)?.id, source.id)
	})
})
