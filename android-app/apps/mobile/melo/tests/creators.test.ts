import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import {
	CreatorStore,
	type Creator,
	type CreatorFollowInput,
} from '../core/creators'
import { Library, migrate, migrations, type Database } from '../core/database'
import { ListeningLibrary } from '../core/listening'
import { sourceId, type Source } from '../core/model'
import { PlaylistStore } from '../core/playlists'
import { playlistEntryId } from '../core/queue'
import { SessionStore } from '../core/sessions'

function open(file = ':memory:') {
	const raw = new DatabaseSync(file)
	const db: Database = {
		execSync: (sql) => raw.exec(sql),
		runSync: (sql, values) => raw.prepare(sql).run(...values),
		getAllSync: <T>(sql: string, values: (string | number | null)[]) =>
			raw.prepare(sql).all(...values) as T[],
		getFirstSync: <T>(sql: string, values: (string | number | null)[]) =>
			(raw.prepare(sql).get(...values) as T) ?? null,
	}
	return { raw, db }
}

const creator: Creator = {
	source: 'bilibili',
	mid: '88',
	name: ' 上传者 ',
	fetchedAt: 100,
}
const input: CreatorFollowInput = {
	profileId: 'local',
	creatorMid: '88',
	scope: 'music',
	origin: 'manual',
}
const source = (cid: number): Source => ({
	id: sourceId('BV1vT411i7ET', cid),
	bvid: 'BV1vT411i7ET',
	cid,
	originalTitle: `原稿${cid}`,
	uploader: '同昵称',
	uploaderId: 88,
	performer: null,
	artwork: '',
	duration: 300,
	domain: 'unclassified',
	audioAvailability: 'unknown',
})

function seedOld(db: Database) {
	const a = source(1),
		b = source(2)
	const library = new Library(db)
	library.setLiked(a, true)
	library.save(b)
	library.setSetting('theme', 'anime')
	new ListeningLibrary(db).saveResumePoint({
		sourceId: a.id,
		positionSeconds: 42,
		durationSeconds: 300,
		completed: false,
		updatedAt: 100,
	})
	const playlists = new PlaylistStore(db)
	playlists.create('p', '重复歌单')
	playlists.append(
		'p',
		[
			{ itemId: 'a1', source: a },
			{ itemId: 'b', source: b },
			{ itemId: 'a2', source: a },
		],
		'keep-all',
	)
	new SessionStore(db).saveSession({
		mode: 'music',
		entries: [
			{ entryId: playlistEntryId('a1'), sourceId: a.id },
			{ entryId: playlistEntryId('b'), sourceId: b.id },
			{ entryId: playlistEntryId('a2'), sourceId: a.id },
		],
		currentEntryId: playlistEntryId('a2'),
		currentSourceId: a.id,
		positionSeconds: 52,
		speed: 1,
		updatedAt: 101,
	})
	new SessionStore(db).saveSession({
		mode: 'listening',
		entries: [{ entryId: b.id, sourceId: b.id }],
		currentEntryId: b.id,
		currentSourceId: b.id,
		positionSeconds: 99,
		speed: 1.5,
		updatedAt: 102,
	})
}

function oldRows(raw: DatabaseSync) {
	return JSON.stringify(
		[
			'sources',
			'likes',
			'settings',
			'resume_points',
			'playlists',
			'playlist_items',
			'playback_sessions',
			'playback_session_items',
		].map((table) =>
			raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
		),
	)
}

function withFile(run: (file: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), 'melocanvas-creators-'))
	if (
		!resolve(dir).startsWith(resolve(tmpdir()) + sep) ||
		!basename(dir).startsWith('melocanvas-creators-')
	)
		throw new Error('Refusing cleanup outside test root')
	try {
		run(join(dir, 'library.db'))
	} finally {
		rmSync(dir, { recursive: true })
	}
}

function setup() {
	const connection = open()
	migrate(connection.db)
	const store = new CreatorStore(connection.db)
	store.saveCreator(creator)
	return { ...connection, store }
}

void test('v5→v6和重开逐字段保留旧域、重复歌单、第三项A精确游标，且不从昵称迁移关注', () => {
	withFile((file) => {
		let { db, raw } = open(file)
		let before = ''
		try {
			migrate(db, migrations.slice(0, 5))
			seedOld(db)
			before = oldRows(raw)
			migrate(db, migrations.slice(0, 6))
			assert.equal(oldRows(raw), before)
			const store = new CreatorStore(db)
			assert.equal(store.getCreator('88'), null)
			assert.deepEqual(store.listSubscriptions('local'), [])
			store.saveCreator(creator)
			store.follow(input)
		} finally {
			raw.close()
		}
		;({ db, raw } = open(file))
		try {
			migrate(db, migrations.slice(0, 6))
			assert.equal(
				raw.prepare('PRAGMA user_version').get()?.user_version,
				6,
			)
			assert.equal(oldRows(raw), before)
			assert.equal(
				new SessionStore(db).getSession('music')?.currentEntryId,
				playlistEntryId('a2'),
			)
			assert.deepEqual(
				new PlaylistStore(db).get('p')?.items.map((item) => item.sourceId),
				[source(1).id, source(2).id, source(1).id],
			)
			assert.equal(
				new CreatorStore(db).getSubscription('local', '88')?.notifications,
				false,
			)
		} finally {
			raw.close()
		}
	})
})

void test('v6迁移中故障完整回滚，重开仍v5原样，重试可升级', () => {
	withFile((file) => {
		let { db, raw } = open(file)
		let before = ''
		try {
			migrate(db, migrations.slice(0, 5))
			seedOld(db)
			before = oldRows(raw)
			const fault: Database = {
				...db,
				execSync: (sql) => {
					db.execSync(sql)
					if (sql.includes('CREATE TABLE creators'))
						throw new Error('migration disk failure')
				},
			}
			assert.throws(() => migrate(fault), /migration disk failure/)
			assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 5)
			assert.equal(
				raw
					.prepare(
						"SELECT name FROM sqlite_master WHERE name IN ('creators', 'creator_subscriptions')",
					)
					.all().length,
				0,
			)
			assert.equal(oldRows(raw), before)
		} finally {
			raw.close()
		}
		;({ db, raw } = open(file))
		try {
			assert.equal(oldRows(raw), before)
			migrate(db, migrations.slice(0, 6))
			assert.equal(oldRows(raw), before)
		} finally {
			raw.close()
		}
	})
})

void test('资料独立保存，省略可选字段读出undefined，过期回包不覆盖，等时间允许刷新', () => {
	const { store, raw } = setup()
	try {
		assert.deepEqual(store.getCreator('88'), { ...creator, name: '上传者' })
		const fresh = {
			...creator,
			name: '新昵称',
			avatar: 'https://example.com/avatar',
			bio: '新简介',
			fetchedAt: 200,
		}
		store.saveCreator(fresh)
		assert.deepEqual(store.saveCreator({ ...creator, name: '旧昵称' }), fresh)
		assert.deepEqual(store.getCreator('88'), fresh)
		store.saveCreator({ ...fresh, name: '同时间刷新' })
		assert.equal(store.getCreator('88')?.name, '同时间刷新')
		assert.throws(() => store.saveCreator({ ...fresh, name: '  ' }), /资料无效/)
		assert.equal(store.getCreator('88')?.name, '同时间刷新')
		store.saveCreator({ ...creator, fetchedAt: 201 })
		assert.equal(store.getCreator('88')?.avatar, undefined)
	} finally {
		raw.close()
	}
})

void test('mid只接受规范正整数十进制字符串，保留超过JS安全整数的精确身份', () => {
	const { store, raw } = setup()
	try {
		for (const mid of [
			'',
			'0',
			'01',
			'-1',
			'+1',
			' 1',
			'1 ',
			'88\n',
			'1.0',
			'1e3',
			'１２',
			88 as unknown as string,
		]) {
			assert.throws(() => store.saveCreator({ ...creator, mid }), /mid 无效/)
			assert.throws(() => store.getCreator(mid), /mid 无效/)
		}
		const mid = '900719925474099312345'
		store.saveCreator({ ...creator, mid })
		assert.equal(store.getCreator(mid)?.mid, mid)
		assert.equal(store.getCreator('900719925474099312346'), null)
	} finally {
		raw.close()
	}
})

void test('关注必须显式合法scope/origin/profile且引用已存资料，通知固定关闭', () => {
	const { store, raw } = setup()
	try {
		for (const scope of ['', 'video', undefined])
			assert.throws(
				() => store.follow({ ...input, scope } as CreatorFollowInput),
				/范围无效/,
			)
		for (const origin of ['', 'remote', undefined])
			assert.throws(
				() => store.follow({ ...input, origin } as CreatorFollowInput),
				/来源无效/,
			)
		for (const profileId of ['', ' local', 'local '])
			assert.throws(() => store.follow({ ...input, profileId }), /档案身份无效/)
		assert.throws(() => store.follow({ ...input, creatorMid: '99' }), /先保存/)
		assert.deepEqual(store.listSubscriptions('local'), [])
		for (const scope of ['all', 'music', 'listening'] as const) {
			const result = store.follow({ ...input, profileId: scope, scope })
			assert.equal(result.created, true)
			assert.equal(result.subscription.notifications, false)
			assert.equal(result.subscription.scope, scope)
		}
	} finally {
		raw.close()
	}
})

void test('重复follow不覆盖原scope/origin/时间，只有显式updateScope改变范围', () => {
	const { store, raw } = setup()
	try {
		const first = store.follow(input)
		assert.deepEqual(
			store.follow({ ...input, scope: 'listening', origin: 'biliImport' }),
			{ subscription: first.subscription, created: false },
		)
		assert.deepEqual(store.updateScope('local', '88', 'all'), {
			...first.subscription,
			scope: 'all',
		})
		store.saveCreator({ ...creator, name: '资料更新', fetchedAt: 200 })
		assert.deepEqual(store.getSubscription('local', '88'), {
			...first.subscription,
			scope: 'all',
		})
		assert.throws(
			() => store.updateScope('local', '88', 'invalid' as 'all'),
			/范围无效/,
		)
		assert.throws(() => store.updateScope('other', '88', 'all'), /已不存在/)
	} finally {
		raw.close()
	}
})

void test('关系按profile+mid隔离，列表仅当前profile且同昵称不合并', () => {
	const { store, raw } = setup()
	try {
		store.saveCreator({ ...creator, mid: '89' })
		store.follow(input)
		store.follow({ ...input, creatorMid: '89', scope: 'all' })
		store.follow({
			...input,
			profileId: 'other',
			scope: 'listening',
			origin: 'biliImport',
		})
		assert.equal(store.listSubscriptions('local').length, 2)
		assert.equal(store.listSubscriptions('other').length, 1)
		store.updateScope('local', '88', 'all')
		assert.equal(store.getSubscription('other', '88')?.scope, 'listening')
		assert.equal(store.unfollow('local', '88'), true)
		assert.equal(store.getSubscription('local', '88'), null)
		assert.equal(store.getSubscription('other', '88')?.scope, 'listening')
		assert.equal(store.getSubscription('local', '89')?.scope, 'all')
	} finally {
		raw.close()
	}
})

void test('取消关注只删本地关系，Creator及喜欢/来源/歌单/续听/双队列全部原样', () => {
	const { store, raw, db } = setup()
	try {
		seedOld(db)
		const before = oldRows(raw),
			profile = store.getCreator('88')
		store.follow(input)
		assert.equal(store.unfollow('local', '88'), true)
		assert.equal(store.unfollow('local', '88'), false)
		assert.equal(oldRows(raw), before)
		assert.deepEqual(store.getCreator('88'), profile)
	} finally {
		raw.close()
	}
})

void test('资料输入校验不破坏缓存，SQL表约束拒绝非法关系/通知和缺失引用', () => {
	const { store, raw, db } = setup()
	try {
		for (const fetchedAt of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
			assert.throws(
				() => store.saveCreator({ ...creator, fetchedAt }),
				/时间无效/,
			)
		assert.throws(
			() => store.saveCreator({ ...creator, source: 'other' as 'bilibili' }),
			/资料无效/,
		)
		assert.throws(
			() => store.saveCreator({ ...creator, bio: null as unknown as string }),
			/资料无效/,
		)
		for (const [mid, scope, notifications, origin] of [
			['88', 'video', 0, 'manual'],
			['88', 'all', 1, 'manual'],
			['88', 'all', 0, 'remote'],
			['99', 'all', 0, 'manual'],
		])
			assert.throws(() =>
				db.runSync(
					'INSERT INTO creator_subscriptions VALUES (?, ?, ?, ?, ?, ?)',
					['local', mid, scope, 10, notifications, origin],
				),
			)
		assert.deepEqual(store.listSubscriptions('local'), [])
		assert.equal(store.getCreator('88')?.name, '上传者')
	} finally {
		raw.close()
	}
})

void test('真实SQLite FULL自动回滚后保留原错误和旧Creator，重开后仍可使用', () => {
	withFile((file) => {
		let { db, raw } = open(file)
		let before: Creator | null = null
		try {
			migrate(db)
			const store = new CreatorStore(db)
			store.saveCreator(creator)
			store.follow(input)
			before = store.getCreator(creator.mid)
			const pages = raw.prepare('PRAGMA page_count').get()?.page_count
			assert.ok(typeof pages === 'number')
			raw.exec(`PRAGMA max_page_count = ${pages}`)
			assert.throws(
				() =>
					store.saveCreator({
						...creator,
						bio: 'x'.repeat(1024 * 1024),
						fetchedAt: 200,
					}),
				(error: unknown) => {
					assert.ok(error instanceof Error)
					assert.match(error.message, /database or disk is full/)
					assert.equal((error as Error & { errcode: number }).errcode, 13)
					return true
				},
			)
			assert.deepEqual(store.getCreator(creator.mid), before)
			assert.equal(store.getSubscription('local', creator.mid)?.scope, 'music')
		} finally {
			raw.close()
		}
		;({ db, raw } = open(file))
		try {
			migrate(db)
			const store = new CreatorStore(db)
			assert.deepEqual(store.getCreator(creator.mid), before)
			assert.equal(store.getSubscription('local', creator.mid)?.scope, 'music')
			store.saveCreator({ ...creator, name: '重开后更新', fetchedAt: 201 })
			assert.equal(store.getCreator(creator.mid)?.name, '重开后更新')
		} finally {
			raw.close()
		}
	})
})

void test('关注/修改/取消/资料写入的SQL及提交失败均回滚，原错误可诊断并能重试', () => {
	const { store, raw, db } = setup()
	try {
		let failSql = '',
			failCommit = false
		const failure = new Error('disk write failure')
		const faulty = new CreatorStore({
			...db,
			runSync: (sql, values) => {
				const result = db.runSync(sql, values)
				if (failSql && sql.includes(failSql)) throw failure
				return result
			},
			execSync: (sql) => {
				if (failCommit && sql === 'COMMIT') throw failure
				db.execSync(sql)
			},
		})
		failSql = 'INSERT INTO creator_subscriptions'
		assert.throws(
			() => faulty.follow(input),
			(error) => error === failure,
		)
		assert.equal(store.getSubscription('local', '88'), null)
		failSql = ''
		failCommit = true
		assert.throws(
			() => faulty.follow(input),
			(error) => error === failure,
		)
		assert.equal(store.getSubscription('local', '88'), null)
		failCommit = false
		const first = faulty.follow(input).subscription
		for (const [sql, action] of [
			[
				'UPDATE creator_subscriptions',
				() => faulty.updateScope('local', '88', 'all'),
			],
			[
				'DELETE FROM creator_subscriptions',
				() => faulty.unfollow('local', '88'),
			],
			[
				'INSERT INTO creators',
				() =>
					faulty.saveCreator({ ...creator, name: '未提交', fetchedAt: 200 }),
			],
		] as const) {
			failSql = sql
			assert.throws(action, (error) => error === failure)
			assert.deepEqual(store.getSubscription('local', '88'), first)
			assert.equal(store.getCreator('88')?.name, '上传者')
		}
		failSql = ''
		assert.equal(faulty.updateScope('local', '88', 'all').scope, 'all')
		assert.equal(faulty.unfollow('local', '88'), true)
	} finally {
		raw.close()
	}
})
