import type { Database } from './database'

export interface Creator {
	source: 'bilibili'
	mid: string
	name: string
	avatar?: string
	bio?: string
	fetchedAt: number
}

export type CreatorScope = 'all' | 'music' | 'listening'
export type CreatorOrigin = 'manual' | 'biliImport'

export interface CreatorSubscription {
	profileId: string
	creatorMid: string
	scope: CreatorScope
	createdAt: number
	notifications: false
	origin: CreatorOrigin
}

export type CreatorFollowInput = Omit<
	CreatorSubscription,
	'createdAt' | 'notifications'
>
type CreatorRow = Omit<Creator, 'avatar' | 'bio'> & {
	avatar: string | null
	bio: string | null
}
type SubscriptionRow = Omit<CreatorSubscription, 'notifications'> & {
	notifications: number
}

function validateMid(mid: string): void {
	if (typeof mid !== 'string' || mid.trim() !== mid || !/^[1-9][0-9]*$/.test(mid))
		throw new Error('UP 主 mid 无效')
}

function validateProfile(profileId: string): void {
	if (
		typeof profileId !== 'string' ||
		!profileId ||
		profileId.trim() !== profileId
	)
		throw new Error('本地用户档案身份无效')
}

function validateTime(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error('UP 主记录时间无效')
}

function validateScope(scope: CreatorScope): void {
	if (scope !== 'all' && scope !== 'music' && scope !== 'listening')
		throw new Error('本地关注范围无效')
}

function validateOrigin(origin: CreatorOrigin): void {
	if (origin !== 'manual' && origin !== 'biliImport')
		throw new Error('本地关注来源无效')
}

function normalizeCreator(creator: Creator): Creator {
	validateMid(creator.mid)
	validateTime(creator.fetchedAt)
	if (
		creator.source !== 'bilibili' ||
		typeof creator.name !== 'string' ||
		!creator.name.trim()
	)
		throw new Error('UP 主资料无效')
	if (
		(creator.avatar !== undefined && typeof creator.avatar !== 'string') ||
		(creator.bio !== undefined && typeof creator.bio !== 'string')
	)
		throw new Error('UP 主资料无效')
	return { ...creator, name: creator.name.trim() }
}

function subscription(row: SubscriptionRow): CreatorSubscription {
	validateProfile(row.profileId)
	validateMid(row.creatorMid)
	validateScope(row.scope)
	validateOrigin(row.origin)
	validateTime(row.createdAt)
	if (row.notifications !== 0) throw new Error('本地关注通知记录无效')
	return { ...row, notifications: false }
}

/** Local data only. Mutations own their transactions; callers must not wrap them in BEGIN. */
export class CreatorStore {
	constructor(private db: Database) {}

	private atomic<T>(action: () => T): T {
		this.db.execSync('BEGIN IMMEDIATE')
		try {
			const result = action()
			this.db.execSync('COMMIT')
			return result
		} catch (error) {
			try {
				this.db.execSync('ROLLBACK')
			} catch {
				// SQLite may already have rolled back (for example SQLITE_FULL).
				// Preserve the original write error for diagnosis.
			}
			throw error
		}
	}

	saveCreator(value: Creator): Creator {
		const creator = normalizeCreator(value)
		return this.atomic(() => {
			const existing = this.getCreator(creator.mid)
			if (existing && existing.fetchedAt > creator.fetchedAt) return existing
			this.db.runSync(
				`INSERT INTO creators (source, mid, name, avatar, bio, fetchedAt) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(mid) DO UPDATE SET name=excluded.name, avatar=excluded.avatar,
                bio=excluded.bio, fetchedAt=excluded.fetchedAt`,
				[
					creator.source,
					creator.mid,
					creator.name,
					creator.avatar ?? null,
					creator.bio ?? null,
					creator.fetchedAt,
				],
			)
			return creator
		})
	}

	getCreator(mid: string): Creator | null {
		validateMid(mid)
		const row = this.db.getFirstSync<CreatorRow>(
			'SELECT * FROM creators WHERE mid = ?',
			[mid],
		)
		if (!row) return null
		const { avatar, bio, ...creator } = row
		return normalizeCreator({
			...creator,
			...(avatar !== null ? { avatar } : {}),
			...(bio !== null ? { bio } : {}),
		})
	}

	getSubscription(
		profileId: string,
		creatorMid: string,
	): CreatorSubscription | null {
		validateProfile(profileId)
		validateMid(creatorMid)
		const row = this.db.getFirstSync<SubscriptionRow>(
			'SELECT * FROM creator_subscriptions WHERE profileId = ? AND creatorMid = ?',
			[profileId, creatorMid],
		)
		return row ? subscription(row) : null
	}

	listSubscriptions(profileId: string): CreatorSubscription[] {
		validateProfile(profileId)
		return this.db
			.getAllSync<SubscriptionRow>(
				'SELECT * FROM creator_subscriptions WHERE profileId = ? ORDER BY createdAt DESC, creatorMid',
				[profileId],
			)
			.map(subscription)
	}

	follow(input: CreatorFollowInput): {
		subscription: CreatorSubscription
		created: boolean
	} {
		validateProfile(input.profileId)
		validateMid(input.creatorMid)
		validateScope(input.scope)
		validateOrigin(input.origin)
		return this.atomic(() => {
			const existing = this.getSubscription(input.profileId, input.creatorMid)
			if (existing) return { subscription: existing, created: false }
			if (!this.getCreator(input.creatorMid))
				throw new Error('请先保存 UP 主资料再关注')
			const createdAt = Date.now()
			validateTime(createdAt)
			const value: CreatorSubscription = {
				...input,
				createdAt,
				notifications: false,
			}
			this.db.runSync(
				'INSERT INTO creator_subscriptions (profileId, creatorMid, scope, createdAt, notifications, origin) VALUES (?, ?, ?, ?, 0, ?)',
				[
					value.profileId,
					value.creatorMid,
					value.scope,
					value.createdAt,
					value.origin,
				],
			)
			return { subscription: value, created: true }
		})
	}

	updateScope(
		profileId: string,
		creatorMid: string,
		scope: CreatorScope,
	): CreatorSubscription {
		validateScope(scope)
		return this.atomic(() => {
			const existing = this.getSubscription(profileId, creatorMid)
			if (!existing) throw new Error('这条本地关注已不存在')
			this.db.runSync(
				'UPDATE creator_subscriptions SET scope = ? WHERE profileId = ? AND creatorMid = ?',
				[scope, profileId, creatorMid],
			)
			return { ...existing, scope }
		})
	}

	unfollow(profileId: string, creatorMid: string): boolean {
		return this.atomic(() => {
			const existing = this.getSubscription(profileId, creatorMid)
			if (!existing) return false
			this.db.runSync(
				'DELETE FROM creator_subscriptions WHERE profileId = ? AND creatorMid = ?',
				[profileId, creatorMid],
			)
			return true
		})
	}
}
