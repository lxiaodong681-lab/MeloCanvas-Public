import type { LocalAudio, LocalAudioStore } from './core/local-audio'

export interface PickedLocalAudio {
	uri: string
	name: string
	release?(): void
}
export interface LocalAudioFiles {
	pick(): Promise<PickedLocalAudio | null>
	prepare(file: {
		uri: string
		name: string
	}): Promise<{ audio: LocalAudio; discard(): void }>
}
export interface LocalAudioState {
	items: LocalAudio[]
	busy: boolean
	error: string
	notice: string
}
export class LocalAudioImport {
	state: LocalAudioState = { items: [], busy: false, error: '', notice: '' }
	private generation = 0
	constructor(
		private store: Pick<LocalAudioStore, 'list' | 'add'>,
		private files: LocalAudioFiles,
		private changed: () => void,
	) {
		try {
			this.state.items = store.list()
		} catch (error) {
			this.state.error =
				error instanceof Error ? error.message : '读取本地音频失败'
		}
	}
	private emit(patch: Partial<LocalAudioState>) {
		this.state = { ...this.state, ...patch }
		this.changed()
	}
	refresh() {
		try {
			this.emit({ items: this.store.list(), error: '' })
		} catch (error) {
			this.emit({
				error:
					error instanceof Error ? error.message : '读取本地音频失败，请重试',
			})
		}
	}
	dispose() {
		this.generation++
	}
	cancel() {
		this.generation++
		this.emit({ busy: false, notice: '已取消导入' })
	}
	async importFile() {
		if (this.state.busy) return
		const generation = ++this.generation
		this.emit({ busy: true, error: '', notice: '' })
		let prepared: Awaited<ReturnType<LocalAudioFiles['prepare']>> | null = null
		let committed = false
		let picked: PickedLocalAudio | null = null
		try {
			picked = await this.files.pick()
			if (!picked || generation !== this.generation) return
			prepared = await this.files.prepare(picked)
			if (generation !== this.generation) return
			this.store.add(prepared.audio)
			committed = true
			this.refresh()
			this.emit({ notice: `已导入 ${prepared.audio.title}` })
		} catch (error) {
			if (generation === this.generation)
				this.emit({
					error:
						error instanceof Error ? error.message : '导入失败，请重新选择文件',
				})
		} finally {
			try {
				picked?.release?.()
			} catch {
				/* The import result remains authoritative. */
			}
			if (prepared && !committed) {
				try {
					prepared.discard()
				} catch {
					/* Keep import error. */
				}
			}
			if (generation === this.generation) this.emit({ busy: false })
		}
	}
}
