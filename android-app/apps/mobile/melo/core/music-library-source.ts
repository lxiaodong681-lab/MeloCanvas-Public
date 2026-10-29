import type { LocalAudio } from './local-audio'
import type { Source } from './model'

export interface LocalLibrarySource {
	kind: 'local'
	id: string
	originalTitle: string
	uploader: string
	performer: string
	artwork: string
	duration: number
	originalName: string
	bvid?: never
}
export type MusicLibrarySource = Source | LocalLibrarySource
export const isLocalLibrarySource = (
	source: MusicLibrarySource,
): source is LocalLibrarySource => 'kind' in source && source.kind === 'local'
export const localLibrarySource = (audio: LocalAudio): LocalLibrarySource => ({
	kind: 'local',
	id: audio.id,
	originalTitle: audio.title,
	uploader: audio.artist,
	performer: audio.artist,
	artwork: '',
	duration: audio.durationSeconds,
	originalName: audio.originalName,
})
