import {
	ThemeLayoutRejectedError,
	ThemePresentationTransientError,
	type ThemeInstallDependencies,
	type ThemePresentation,
	type ThemePresentationLease,
	type ThemePresentationPurpose,
} from './core/theme-install-types'
import type { ThemeControlRowStatus } from './theme-control-layout'

export const themeLayoutScopes = Object.freeze([
	'navigation',
	'mini-music',
	'mini-listening',
	'music-transport',
	'listening-transport',
	'common-button',
	'progress',
] as const)
export type ThemeLayoutScope = (typeof themeLayoutScopes)[number]
export type ThemeLayoutPurpose = ThemePresentationPurpose | 'current'
/** Compare this object by reference; value is only a local React key. */
export interface ThemeLayoutRequestId {
	readonly value: number
}
export interface ThemeLayoutGateRequest {
	readonly id: ThemeLayoutRequestId
	readonly presentation: ThemePresentation
	readonly purpose: ThemeLayoutPurpose
	readonly environmentRevision: number | null
	/** Current-display visit only; never serialized or supplied by a package. */
	readonly currentVisit?: object
}
export interface ThemeLayoutGateSnapshot {
	readonly request: ThemeLayoutGateRequest | null
	readonly environmentRevision: number | null
	readonly probeRound: number | null
	readonly phase: 'idle' | 'pending' | 'ready' | 'rejected' | 'invalidated'
	readonly reports: Readonly<
		Partial<Record<ThemeLayoutScope, ThemeControlRowStatus>>
	>
	readonly failure:
		| ThemeLayoutRejectedError
		| ThemePresentationTransientError
		| null
}
export interface ThemeLayoutProbe {
	report(scope: ThemeLayoutScope, status: ThemeControlRowStatus): void
	dispose(): void
}
type Reports = Partial<Record<ThemeLayoutScope, ThemeControlRowStatus>>
interface ProbeRound {
	id: number
	active: boolean
	reports: Reports
}
interface Candidate {
	id: ThemeLayoutRequestId
	presentation: ThemePresentation
	purpose: ThemeLayoutPurpose
	currentVisit?: object
	environmentRevision: number | null
	signal: AbortSignal
	releaseSignal: () => void
	active: boolean
	settled: boolean
	leaseValid: boolean
	probe: ProbeRound | null
	resolve: (lease: ThemePresentationLease) => void
	reject: (error: Error) => void
}
const transient = (
	reason: ThemePresentationTransientError['reason'],
	message = '主题显示环境已变化，请重新尝试',
) => new ThemePresentationTransientError(reason, message)
const inactiveProbe: ThemeLayoutProbe = Object.freeze({
	report() {},
	dispose() {},
})

/** Copy observations, not fit mathematics. Reports come from the actual row resolver. */
function copyStatus(status: ThemeControlRowStatus): ThemeControlRowStatus {
	if (status.kind === 'pending') return { kind: 'pending' }
	const resolution = status.resolution
	if (
		!Number.isFinite(resolution.requiredWidthDp) ||
		resolution.requiredWidthDp <= 0
	)
		throw new Error('主题测量报告不完整')
	if (status.kind === 'rejected' && resolution.kind === 'rejected') {
		if (
			resolution.reason !== 'insufficient-width' ||
			!Number.isFinite(resolution.availableWidthDp) ||
			resolution.availableWidthDp <= 0
		)
			throw new Error('主题测量报告不完整')
		return { kind: 'rejected', resolution: { ...resolution } }
	}
	if (status.kind === 'ready' && resolution.kind !== 'rejected') {
		if (
			!['regular', 'compact', 'host-single-row'].includes(resolution.kind) ||
			!Number.isFinite(resolution.touchDp) ||
			resolution.touchDp < 48 ||
			!Array.isArray(resolution.minWidthsDp) ||
			!resolution.minWidthsDp.length ||
			resolution.minWidthsDp.some(
				(width) => !Number.isFinite(width) || width < 0,
			)
		)
			throw new Error('主题测量报告不完整')
		return {
			kind: 'ready',
			resolution: { ...resolution, minWidthsDp: [...resolution.minWidthsDp] },
		}
	}
	throw new Error('主题测量报告不完整')
}

/** One candidate, seven fixed scopes. No renderer, persistence or activation decisions. */
export class ThemeLayoutGate {
	private environmentRevision: number | null = null
	private sequence = 0
	private roundSequence = 0
	private candidate: Candidate | null = null
	private listeners = new Set<() => void>()
	private snapshot: ThemeLayoutGateSnapshot = {
		request: null,
		environmentRevision: null,
		probeRound: null,
		phase: 'idle',
		reports: {},
		failure: null,
	}
	getSnapshot = () => this.snapshot
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private requestId(): ThemeLayoutRequestId {
		if (!Number.isSafeInteger(this.sequence + 1))
			throw transient('unavailable', '主题测量请求数量超限')
		return Object.freeze({ value: ++this.sequence })
	}
	private publish(
		phase: ThemeLayoutGateSnapshot['phase'],
		failure: ThemeLayoutGateSnapshot['failure'] = null,
	) {
		const current = this.candidate,
			reports: Reports = {}
		for (const scope of themeLayoutScopes) {
			const status = current?.probe?.reports[scope]
			if (status) reports[scope] = copyStatus(status)
		}
		this.snapshot = {
			request: current
				? Object.freeze({
						id: current.id,
						presentation: current.presentation,
						purpose: current.purpose,
						...(current.currentVisit
							? { currentVisit: current.currentVisit }
							: {}),
						environmentRevision: current.environmentRevision,
					})
				: null,
			environmentRevision: this.environmentRevision,
			probeRound: current?.probe?.id ?? null,
			phase,
			reports,
			failure,
		}
		for (const listener of this.listeners) listener()
	}
	private retire(
		current: Candidate,
		error: ThemeLayoutGateSnapshot['failure'],
		notify = true,
	) {
		current.active = false
		current.leaseValid = false
		current.releaseSignal()
		if (current.probe) current.probe.active = false
		if (!current.settled) {
			current.settled = true
			current.reject(error ?? transient('stale'))
		}
		if (this.candidate === current) {
			this.candidate = null
			if (notify)
				this.publish(
					error instanceof ThemeLayoutRejectedError
						? 'rejected'
						: 'invalidated',
					error,
				)
		}
	}
	setEnvironmentRevision = (revision: number | null) => {
		if (revision !== null && (!Number.isSafeInteger(revision) || revision < 0))
			throw new RangeError('主题显示环境版本必须为非负安全整数或null')
		if (revision === this.environmentRevision) return
		this.environmentRevision = revision
		const current = this.candidate
		if (
			current?.environmentRevision === null &&
			revision !== null &&
			!current.settled
		) {
			// Initial unknown environment has no accepted observations. Remount its probe.
			current.id = this.requestId()
			current.environmentRevision = revision
			this.publish('pending')
		} else if (current) this.retire(current, transient('stale'))
		else this.publish('idle')
	}
	preparePresentation: NonNullable<
		ThemeInstallDependencies['preparePresentation']
	> = (presentation, context) => this.prepare(presentation, context)
	/** Observe a verified current package; never authorizes installation or persistence. */
	observeCurrent = (
		presentation: ThemePresentation,
		signal: AbortSignal,
		currentVisit: object,
	) => this.prepare(presentation, { purpose: 'current', signal, currentVisit })
	private prepare(
		presentation: ThemePresentation,
		{
			purpose,
			signal,
			currentVisit,
		}: {
			purpose: ThemeLayoutPurpose
			signal: AbortSignal
			currentVisit?: object
		},
	) {
		let resolve!: Candidate['resolve'], reject!: Candidate['reject']
		const promise = new Promise<ThemePresentationLease>((yes, no) => {
			resolve = yes
			reject = no
		})
		// Consumers still receive rejection; cancellation never leaves an orphan rejection.
		void promise.catch(() => {})
		if (signal.aborted) {
			reject(transient('cancelled', '主题测量已取消'))
			return promise
		}
		const id = this.requestId()
		if (this.candidate) this.retire(this.candidate, transient('stale'), false)
		const current: Candidate = {
			id,
			presentation,
			purpose,
			...(currentVisit ? { currentVisit } : {}),
			environmentRevision: this.environmentRevision,
			signal,
			releaseSignal: () => signal.removeEventListener('abort', abort),
			active: true,
			settled: false,
			leaseValid: false,
			probe: null,
			resolve,
			reject,
		}
		const abort = () =>
			this.retire(current, transient('cancelled', '主题测量已取消'))
		this.candidate = current
		signal.addEventListener('abort', abort, { once: true })
		if (signal.aborted) abort()
		else this.publish('pending')
		return promise
	}
	private owns(current: Candidate, probe: ProbeRound) {
		return (
			this.candidate === current &&
			current.active &&
			!current.signal.aborted &&
			current.environmentRevision !== null &&
			current.environmentRevision === this.environmentRevision &&
			current.probe === probe &&
			probe.active
		)
	}
	attachProbe = (requestId: ThemeLayoutRequestId): ThemeLayoutProbe => {
		const current = this.candidate
		if (
			!current ||
			current.id !== requestId ||
			current.environmentRevision === null
		)
			return inactiveProbe
		if (current.settled) {
			this.retire(current, transient('stale'))
			return inactiveProbe
		}
		if (current.probe) current.probe.active = false
		const probe: ProbeRound = {
			id: ++this.roundSequence,
			active: true,
			reports: {},
		}
		current.probe = probe
		this.publish('pending')
		return {
			report: (scope, status) => {
				if (!this.owns(current, probe)) return
				let observation: ThemeControlRowStatus
				try {
					if (!(themeLayoutScopes as readonly string[]).includes(scope))
						throw new Error('未知主题测量范围')
					observation = copyStatus(status)
				} catch (cause) {
					this.retire(
						current,
						new ThemePresentationTransientError(
							'unavailable',
							'主题测量报告暂不可用',
							{ cause },
						),
					)
					return
				}
				if (
					JSON.stringify(probe.reports[scope]) === JSON.stringify(observation)
				)
					return
				if (current.settled) {
					this.retire(current, transient('stale'))
					return
				}
				if (observation.kind === 'rejected') {
					this.retire(
						current,
						new ThemeLayoutRejectedError(
							'主题控件不适合当前宽度，请使用兼容主题',
						),
					)
					return
				}
				probe.reports[scope] = observation
				if (
					!themeLayoutScopes.every(
						(item) => probe.reports[item]?.kind === 'ready',
					)
				) {
					this.publish('pending')
					return
				}
				current.settled = true
				current.leaseValid = true
				this.publish('ready')
				current.resolve({
					assertCurrent: () => {
						if (!current.leaseValid || !this.owns(current, probe))
							throw transient('stale')
					},
				})
			},
			dispose: () => {
				if (!this.owns(current, probe)) return
				probe.active = false
				if (current.settled) this.retire(current, transient('stale'))
				else {
					current.probe = null
					this.publish('pending')
				}
			},
		}
	}
	stop = () => {
		if (this.candidate)
			this.retire(this.candidate, transient('cancelled', '主题测量已停止'))
		else if (this.snapshot.phase !== 'idle') this.publish('idle')
	}
}
