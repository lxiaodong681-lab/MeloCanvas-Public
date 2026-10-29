import {
	importTaskLimits as limits,
	type ImportCandidate,
	type ImportDirectorySnapshot,
	type ImportMetadata,
	type ImportReview,
	type ImportRetryInput,
} from './import-types'
import { sourceId } from './model'

export function invalid(message = '导入目录数据无效'): never {
	throw new Error(message)
}
export function id(value: string): void {
	if (
		typeof value !== 'string' ||
		!value ||
		value.trim() !== value ||
		value.length > limits.idLength ||
		value.includes('\0')
	)
		invalid('导入身份无效')
}
export function integer(value: number, minimum = 0): void {
	if (!Number.isSafeInteger(value) || value < minimum)
		invalid('导入序号或版本无效')
}
export function object(value: unknown): void {
	if (
		!value ||
		typeof value !== 'object' ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null)
	)
		invalid()
}
export function keys(value: object, allowed: string[]): void {
	if (
		Reflect.ownKeys(value).some(
			(key) => typeof key !== 'string' || !allowed.includes(key),
		)
	)
		invalid()
}
function utf8Length(value: string): number {
	let size = 0
	for (const character of value) {
		const point = character.codePointAt(0)!
		size += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
	}
	return size
}
/** Canonical objects, ordered arrays, bounded traversal; never invoke metadata getters/toJSON. */
export function json(
	value: unknown,
	maxBytes: number,
	maxDepth: number = limits.metadataDepth,
): string {
	let remaining = maxBytes
	const ancestors = new Set<object>()
	function token(text: string): string {
		remaining -= utf8Length(text)
		if (remaining < 0) invalid('导入元数据超过大小上限')
		return text
	}
	function encode(item: unknown, depth: number): string {
		if (depth > maxDepth) invalid('导入元数据嵌套过深')
		if (item === null) return token('null')
		if (typeof item === 'boolean') return token(String(item))
		if (typeof item === 'number' && Number.isFinite(item))
			return token(JSON.stringify(item))
		if (typeof item === 'string') {
			if (item.length > remaining) invalid('导入元数据超过大小上限')
			return token(JSON.stringify(item))
		}
		if (!item || typeof item !== 'object' || ancestors.has(item)) invalid()
		ancestors.add(item)
		let result: string
		if (Array.isArray(item)) {
			if (
				item.length > remaining ||
				Reflect.ownKeys(item).length !== item.length + 1
			)
				invalid()
			result =
				token('[') +
				Array.from({ length: item.length }, (_, index) => {
					const property = Object.getOwnPropertyDescriptor(item, String(index))
					if (!property || !('value' in property)) invalid()
					return (index ? token(',') : '') + encode(property.value, depth + 1)
				}).join('') +
				token(']')
		} else {
			object(item)
			const names = Reflect.ownKeys(item)
			if (
				names.length > remaining ||
				names.some((name) => typeof name !== 'string')
			)
				invalid()
			result =
				token('{') +
				(names as string[])
					.sort()
					.map((name, index) => {
						const property = Object.getOwnPropertyDescriptor(item, name)!
						if (!property.enumerable || !('value' in property)) invalid()
						return (
							(index ? token(',') : '') +
							token(JSON.stringify(name)) +
							token(':') +
							encode(property.value, depth + 1)
						)
					})
					.join('') +
				token('}')
		}
		ancestors.delete(item)
		return result
	}
	return encode(value, 0)
}
export function metadata(
	value: ImportMetadata,
	maxBytes: number,
): ImportMetadata {
	object(value)
	return JSON.parse(json(value, maxBytes)) as ImportMetadata
}
export function directory(value: ImportDirectorySnapshot): {
	snapshot: ImportDirectorySnapshot
	text: string
} {
	object(value)
	keys(value, [
		'taskId',
		'provider',
		'originalPlaylistId',
		'taskVersion',
		'originalMetadata',
		'entries',
	])
	id(value.taskId)
	id(value.originalPlaylistId)
	integer(value.taskVersion, 1)
	if (!['bilibili', 'netease', 'qq', 'kugou', 'kuwo', 'qishui'].includes(value.provider))
		invalid('导入平台无效')
	if (!Array.isArray(value.entries) || value.entries.length > limits.entries)
		invalid('导入目录条目数超过上限')
	let previous = -1,
		bytes = 0
	const seen = new Set<string>()
	const entries = value.entries.map((entry) => {
		object(entry)
		keys(entry, [
			'entryId',
			'originalEntryId',
			'originalPosition',
			'originalMetadata',
		])
		id(entry.entryId)
		if (seen.has(entry.entryId)) invalid('导入出现项身份不能重复')
		seen.add(entry.entryId)
		if (entry.originalEntryId !== null) id(entry.originalEntryId)
		integer(entry.originalPosition)
		if (entry.originalPosition <= previous) invalid('原目录位置必须严格递增')
		previous = entry.originalPosition
		const originalMetadata = metadata(
			entry.originalMetadata,
			limits.entryMetadataBytes,
		)
		bytes += json(originalMetadata, limits.entryMetadataBytes).length
		if (bytes > limits.directoryBytes) invalid('导入目录超过大小上限')
		return { ...entry, originalMetadata }
	})
	const snapshot = {
		...value,
		originalMetadata: metadata(
			value.originalMetadata,
			limits.playlistMetadataBytes,
		),
		entries,
	}
	return {
		snapshot,
		text: json(snapshot, limits.directoryBytes, limits.metadataDepth + 4),
	}
}
export function reviewValue(value: ImportReview): ImportReview {
	object(value)
	keys(value, ['state', 'candidates', 'confirmation'])
	if (
		![
			'pending',
			'needs-review',
			'not-found',
			'unreadable',
			'confirmed',
		].includes(value.state)
	)
		invalid('导入审核状态无效')
	if (
		!Array.isArray(value.candidates) ||
		value.candidates.length > limits.candidates
	)
		invalid('导入候选数量超过上限')
	const seen = new Set<string>()
	const candidates = value.candidates.map((candidate): ImportCandidate => {
		object(candidate)
		keys(candidate, ['candidateId', 'bvid', 'cid', 'metadata', 'evidence'])
		id(candidate.candidateId)
		if (seen.has(candidate.candidateId)) invalid('同一出现项的候选身份不能重复')
		seen.add(candidate.candidateId)
		if (
			typeof candidate.bvid !== 'string' ||
			candidate.bvid.trim() !== candidate.bvid ||
			!/^BV[A-Za-z0-9]{10}$/.test(candidate.bvid)
		)
			invalid('候选 BV 身份无效')
		if (candidate.cid !== null) integer(candidate.cid, 1)
		return {
			...candidate,
			metadata: metadata(candidate.metadata, limits.entryMetadataBytes),
			evidence: metadata(candidate.evidence, limits.entryMetadataBytes),
		}
	})
	if (value.state === 'confirmed') {
		if (!value.confirmation) invalid('请明确确认候选音源')
		object(value.confirmation)
		keys(value.confirmation, ['candidateId', 'sourceId'])
		id(value.confirmation.candidateId)
		id(value.confirmation.sourceId)
		const chosen = candidates.find(
			(item) => item.candidateId === value.confirmation!.candidateId,
		)
		if (
			!chosen ||
			chosen.cid === null ||
			value.confirmation.sourceId !== sourceId(chosen.bvid, chosen.cid)
		)
			invalid('确认音源必须对应明确的 BV 与 CID 候选')
	} else if (value.confirmation !== null)
		invalid('只有用户明确确认后才能保存确认关系')
	const normalized = {
		state: value.state,
		candidates,
		confirmation:
			value.confirmation === null ? null : { ...value.confirmation },
	}
	json(normalized, limits.reviewBytes, limits.metadataDepth + 3)
	return normalized
}
export function retryValue(value: ImportRetryInput): ImportRetryInput {
	object(value)
	keys(value, ['errorCode', 'message'])
	if (value.errorCode !== null) id(value.errorCode)
	if (
		typeof value.message !== 'string' ||
		!value.message.trim() ||
		value.message.length > 4096
	)
		invalid('重试记录说明无效')
	return { ...value }
}
