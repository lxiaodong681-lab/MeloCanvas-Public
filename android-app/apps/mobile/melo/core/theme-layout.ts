/** Author permission for a narrower control row, never an implicit clamp. */
export interface ThemeCompactLayout {
	compactMinTouchDp?: number
	narrowFallback: 'reject' | 'host-single-row'
}

export interface ThemeControlRowPolicy extends ThemeCompactLayout {
	minTouchDp: number
}

export interface ThemeControlRowMeasurements {
	/** Actual container width after padding and safe-area insets. */
	availableWidthDp: number
	/** Host-measured necessary widths, including text at the current font scale. */
	controlMinWidthsDp: readonly number[]
	gapDp: number
}

export type ThemeControlRowResolution =
	| {
			kind: 'regular' | 'compact' | 'host-single-row'
			touchDp: number
			minWidthsDp: number[]
			requiredWidthDp: number
	  }
	| {
			kind: 'rejected'
			reason: 'insufficient-width'
			requiredWidthDp: number
			availableWidthDp: number
	  }

function touch(value: number): void {
	if (!Number.isInteger(value) || value < 48 || value > 96)
		throw new RangeError(
			'Theme touch size must be an integer between 48 and 96dp',
		)
}

/** Pure single-row decision. Does not measure, render, wrap, hide or reorder controls. */
export function resolveThemeControlRow(
	policy: ThemeControlRowPolicy,
	measurements: ThemeControlRowMeasurements,
): ThemeControlRowResolution {
	touch(policy.minTouchDp)
	if (policy.compactMinTouchDp !== undefined) {
		touch(policy.compactMinTouchDp)
		if (policy.compactMinTouchDp > policy.minTouchDp)
			throw new RangeError('Compact touch size cannot exceed the regular size')
	}
	if (!['reject', 'host-single-row'].includes(policy.narrowFallback))
		throw new TypeError('Unknown narrow-row fallback')
	const { availableWidthDp, controlMinWidthsDp, gapDp } = measurements
	if (
		!Number.isFinite(availableWidthDp) ||
		availableWidthDp <= 0 ||
		!Number.isFinite(gapDp) ||
		gapDp < 0 ||
		controlMinWidthsDp.length === 0 ||
		[...controlMinWidthsDp].some(
			(width) => !Number.isFinite(width) || width < 0,
		)
	)
		throw new RangeError(
			'Control rows require finite, measured widths and gaps',
		)
	const choices: {
		kind: 'regular' | 'compact' | 'host-single-row'
		touchDp: number
	}[] = [{ kind: 'regular', touchDp: policy.minTouchDp }]
	if (policy.compactMinTouchDp !== undefined)
		choices.push({ kind: 'compact', touchDp: policy.compactMinTouchDp })
	if (policy.narrowFallback === 'host-single-row')
		choices.push({ kind: 'host-single-row', touchDp: 48 })
	let requiredWidthDp = 0
	for (const choice of choices) {
		const minWidthsDp = controlMinWidthsDp.map((width) =>
			Math.max(choice.touchDp, width),
		)
		requiredWidthDp =
			minWidthsDp.reduce((sum, width) => sum + width, 0) +
			gapDp * (minWidthsDp.length - 1)
		if (!Number.isFinite(requiredWidthDp))
			throw new RangeError('Control row width overflow')
		if (requiredWidthDp <= availableWidthDp)
			return { ...choice, minWidthsDp, requiredWidthDp }
	}
	return {
		kind: 'rejected',
		reason: 'insufficient-width',
		requiredWidthDp,
		availableWidthDp,
	}
}

/** Four primary destinations always remain one row, in the caller's original order. */
export function resolveThemeNavigation(
	policy: ThemeControlRowPolicy,
	measurements: Omit<ThemeControlRowMeasurements, 'gapDp'>,
): ThemeControlRowResolution {
	if (measurements.controlMinWidthsDp.length !== 4)
		throw new RangeError('Primary navigation requires exactly four controls')
	return resolveThemeControlRow(policy, { ...measurements, gapDp: 0 })
}
