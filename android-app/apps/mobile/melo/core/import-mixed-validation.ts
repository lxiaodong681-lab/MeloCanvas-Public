import {
	contentKinds,
	type ContentKind,
	type MixedTargetKind,
} from './import-mixed-types'
import type {
	ImportDirectoryEntry,
	ImportJson,
	ImportMetadata,
} from './import-types'
import { invalid, object } from './import-validation'

export function contentKind(value: ContentKind): ContentKind {
	if (!contentKinds.includes(value)) invalid('内容类型无效')
	return value
}
export function mixedTarget(kind: ContentKind): MixedTargetKind {
	return kind === 'song'
		? 'playlist'
		: kind === 'unknown'
			? 'unclassified'
			: 'listening'
}
function bv(value: ImportJson | undefined): string | null {
	if (value === undefined || value === null || value === '') return null
	if (typeof value !== 'string' || !/^BV[A-Za-z0-9]{10}$/.test(value))
		invalid('原目录 BV 身份无效')
	return value
}
/** Only the frozen directory carries original identity. Candidates cannot supply a missing BV. */
export function originalVideoBvid(entry: ImportDirectoryEntry): string | null {
	const observed = entry.originalMetadata.observed
	const media = entry.originalMetadata.media
	if (observed !== undefined) object(observed)
	if (media !== undefined) object(media)
	const observedBv =
		observed === undefined ? undefined : (observed as ImportMetadata).bvid
	const mediaBv =
		media === undefined ? undefined : (media as ImportMetadata).bvid
	const left = bv(observedBv),
		right = bv(mediaBv)
	if (observedBv !== undefined && mediaBv !== undefined && left !== right)
		invalid('原目录 BV 证据不一致')
	return left ?? right
}
