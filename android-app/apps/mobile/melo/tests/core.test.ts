import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Library, migrate, migrations, type Database } from '../core/database'
import {
	parseSearchInput,
	playbackError,
	sourceId,
	sourceUri,
	type Source,
} from '../core/model'
import {
	builtInThemes,
	resolveTheme,
	themeConfigs,
	themeOrFallback,
	validThemeKey,
} from '../core/theme'

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
	return { db, raw }
}
const source: Source = {
	id: sourceId('BV1vT411i7ET', 123),
	bvid: 'BV1vT411i7ET',
	cid: 123,
	originalTitle: '真实原标题',
	uploader: '上传者',
	uploaderId: 88,
	performer: null,
	artwork: 'https://i0.hdslb.com/example.jpg',
	duration: 310,
	domain: 'unclassified',
	audioAvailability: 'unknown',
}

void test('喜欢写入幂等、元数据保留、取消后重开仍不存在', () => {
	const dir = mkdtempSync(join(tmpdir(), 'melocanvas-db-'))
	if (
		!resolve(dir).startsWith(resolve(tmpdir()) + sep) ||
		!basename(dir).startsWith('melocanvas-db-')
	)
		throw new Error(
			'Refusing to remove a directory outside this test temporary root',
		)
	const file = join(dir, 'library.db')
	try {
		let { db, raw } = open(file)
		migrate(db)
		let library = new Library(db)
		library.setLiked(source, true)
		library.setLiked(source, true)
		assert.equal(library.likes().length, 1)
		assert.equal(library.likes()[0].performer, null)
		assert.equal(library.likes()[0].uploader, '上传者')
		raw.close()
		;({ db, raw } = open(file))
		migrate(db)
		library = new Library(db)
		assert.equal(library.likes()[0].id, source.id)
		library.setLiked(source, false)
		library.setLiked(source, false)
		raw.close()
		;({ db, raw } = open(file))
		migrate(db)
		assert.deepEqual(new Library(db).likes(), [])
		raw.close()
	} finally {
		rmSync(dir, { recursive: true })
	}
})

void test('迁移中途失败回滚 schema、版本和已保存的收藏', () => {
	const { db, raw } = open()
	migrate(db, [migrations[0]])
	const library = new Library(db)
	library.setLiked(source, true)
	assert.throws(() =>
		migrate(db, [
			migrations[0],
			'ALTER TABLE sources ADD COLUMN scratch TEXT; INSERT INTO missing_table VALUES (1);',
		]),
	)
	assert.equal(
		db.getFirstSync<{ user_version: number }>('PRAGMA user_version', [])
			?.user_version,
		1,
	)
	assert.equal(library.likes()[0].id, source.id)
	assert.equal(
		db
			.getAllSync<{ name: string }>('PRAGMA table_info(sources)', [])
			.some((column) => column.name === 'scratch'),
		false,
	)
	migrate(db)
	assert.equal(
		db.getFirstSync<{ user_version: number }>('PRAGMA user_version', [])
			?.user_version,
		migrations.length,
	)
	raw.close()
})

void test('收藏提交失败不产生半条来源或假成功', () => {
	const { db, raw } = open()
	migrate(db)
	db.execSync(
		"CREATE TRIGGER fail_like BEFORE INSERT ON likes BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
	)
	const library = new Library(db)
	assert.throws(() => library.setLiked(source, true))
	assert.deepEqual(library.likes(), [])
	assert.equal(library.get(source.id), null)
	raw.close()
})

void test('拒绝较新数据库且保留数据；拒绝伪造来源身份', () => {
	const { db, raw } = open()
	migrate(db)
	const library = new Library(db)
	library.setLiked(source, true)
	db.execSync('PRAGMA user_version = 99')
	assert.throws(() => migrate(db), /较新版本/)
	assert.equal(library.likes().length, 1)
	assert.throws(
		() => library.save({ ...source, id: 'signed-cdn-url' }),
		/身份无效/,
	)
	assert.equal(
		sourceUri(source),
		'orpheus://bilibili?bvid=BV1vT411i7ET&cid=123&quality=30232',
	)
	raw.close()
})

void test('三主题解析出独立背景、图标、卡片、封面框与进度变体', () => {
	assert.deepEqual(
		Object.values(builtInThemes).map((t) => t.components.card),
		['rounded', 'leaf', 'comic'],
	)
	assert.deepEqual(
		Object.values(builtInThemes).map((t) => t.components.playerFrame),
		['stacked', 'arch', 'tilted'],
	)
	assert.deepEqual(
		Object.values(builtInThemes).map((t) => t.components.discoverIcon),
		['home', 'flower', 'star'],
	)
	assert.equal(
		new Set(Object.values(builtInThemes).map((t) => t.assets.hero)).size,
		3,
	)
})

void test('主题坏数据整体回退；可选图片缺失仅资源回退', () => {
	assert.equal(
		themeOrFallback({ ...themeConfigs.anime, schemaVersion: 999 }).id,
		builtInThemes.modern.id,
	)
	assert.throws(
		() =>
			resolveTheme({
				...themeConfigs.modern,
				requiredCapabilities: ['execute-js'],
			}),
		/未支持/,
	)
	assert.throws(
		() =>
			resolveTheme({
				...themeConfigs.modern,
				tokens: {
					...themeConfigs.modern.tokens,
					action: { primary: 'url(evil)' },
				},
			}),
		/颜色无效/,
	)
	assert.throws(
		() =>
			resolveTheme({
				...themeConfigs.modern,
				decorations: { hero: '../secret' },
			}),
		/相对路径/,
	)
	assert.throws(
		() =>
			resolveTheme({
				...themeConfigs.modern,
				decorations: { hero: 'https://evil.test/x.png' },
			}),
		/相对路径/,
	)
	const missing = resolveTheme({
		...themeConfigs.anime,
		decorations: { hero: 'assets/missing.png' },
	})
	assert.equal(missing.assets.hero, 'assets/coast.png')
	assert.equal(missing.warnings.length, 1)
	assert.equal(validThemeKey('broken-id'), 'modern')
})

void test('BV 大小写及 URL 身份保持；空输入和无效 BV 有明确错误', () => {
	assert.deepEqual(parseSearchInput(' BV1vT411i7ET '), {
		type: 'bv',
		bvid: 'BV1vT411i7ET',
	})
	assert.deepEqual(
		parseSearchInput('https://www.bilibili.com/video/BV1vT411i7ET/?p=2'),
		{ type: 'bv', bvid: 'BV1vT411i7ET' },
	)
	assert.deepEqual(parseSearchInput('ヨルシカ'), {
		type: 'keyword',
		keyword: 'ヨルシカ',
	})
	assert.throws(() => parseSearchInput('  '), /请输入/)
	assert.throws(() => parseSearchInput('BV123'), /格式不正确/)
	assert.throws(
		() => parseSearchInput('https://evil.test/video/BV1vT411i7ET'),
		/bilibili/,
	)
	assert.match(playbackError('AudioOnlyUnavailable'), /没有独立音轨/)
	assert.match(playbackError('UnknownHostException'), /网络后重试/)
})

void test('离线未完整保存错误保留明确说明，不提示直接联网重试播放', () => {
	const message = playbackError(
		'IOException: 离线内容缺失或不完整，请联网后重新保存',
	)
	assert.equal(
		message,
		'这首歌曲尚未完整下载，离线时无法播放。请联网后重新保存。',
	)
	assert.doesNotMatch(message, /检查网络后重试/)
})
