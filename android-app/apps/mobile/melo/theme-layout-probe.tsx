import React, {
	useLayoutEffect,
	useMemo,
	useRef,
	type PropsWithChildren,
} from 'react'
import { View } from 'react-native'

import {
	HostFooterFrame,
	ListeningTransportControls,
	MainNavigation,
	MiniPlayerControls,
	MusicTransportControls,
	hostPlayerHorizontalPaddingDp,
} from './host-controls'
import { Progress } from './progress'
import type { ThemeControlRowStatus } from './theme-control-layout'
import {
	themeLayoutScopes,
	type ThemeLayoutGate,
	type ThemeLayoutGateRequest,
	type ThemeLayoutProbe as ProbePort,
	type ThemeLayoutRequestId,
	type ThemeLayoutScope,
} from './theme-layout-gate'
import { Button, ControlRow, ThemeRendererProvider } from './ui'
import type { ThemeLayoutRootBounds } from './useThemeLayoutHost'

const noop = () => {}
function ProbeScope({
	report,
	children,
}: PropsWithChildren<{ report: (status: ThemeControlRowStatus) => void }>) {
	useLayoutEffect(() => () => report({ kind: 'pending' }), [report])
	return children
}

/** Seven real presentation views, never a second business player or remote cover read. */
export function ThemeLayoutProbe({
	gate,
	request,
	bounds,
	bottomInset,
	reducedMotion,
}: {
	gate: ThemeLayoutGate
	request: ThemeLayoutGateRequest | null
	bounds: ThemeLayoutRootBounds | null
	bottomInset: number
	reducedMotion: boolean
}) {
	const probe = useRef<{ id: ThemeLayoutRequestId; port: ProbePort } | null>(
		null,
	)
	const requestId = request?.id
	const reports = useMemo(
		() =>
			Object.fromEntries(
				themeLayoutScopes.map((scope) => [
					scope,
					(status: ThemeControlRowStatus) => {
						const binding = probe.current
						if (binding && binding.id === requestId)
							binding.port.report(scope, status)
					},
				]),
			) as Record<ThemeLayoutScope, (status: ThemeControlRowStatus) => void>,
		[requestId, probe],
	)
	const known =
		!!request &&
		request.environmentRevision !== null &&
		!!bounds &&
		Number.isFinite(bounds.width) &&
		bounds.width > 0 &&
		Number.isFinite(bounds.height) &&
		bounds.height > 0
	useLayoutEffect(() => {
		if (!requestId || !known) return
		const attached = gate.attachProbe(requestId)
		const binding = { id: requestId, port: attached }
		probe.current = binding
		return () => {
			if (probe.current === binding) probe.current = null
			attached.dispose()
		}
	}, [gate, requestId, known])
	if (!known || !request || !bounds) return null
	const presentation = request.presentation
	const revision = request.environmentRevision
	return (
		<View
			testID='theme-layout-probe'
			collapsable={false}
			pointerEvents='none'
			accessible={false}
			accessibilityElementsHidden
			importantForAccessibility='no-hide-descendants'
			accessibilityLiveRegion='none'
			style={{
				position: 'absolute',
				left: 0,
				top: 0,
				right: 0,
				height: 1,
				overflow: 'hidden',
				opacity: 0,
			}}
		>
			<ThemeRendererProvider
				key={request.id.value}
				theme={presentation.theme}
				adapted={presentation.adapted}
				allowedImageUris={presentation.allowedImageUris}
				reducedMotion={reducedMotion}
			>
				<HostFooterFrame>
					<ProbeScope report={reports.navigation}>
						<MainNavigation
							announceStatus={false}
							tab='home'
							bottomInset={bottomInset}
							onNavigate={noop}
							layoutRevision={revision}
							onStatusChange={reports.navigation}
						/>
					</ProbeScope>
					<ProbeScope report={reports['mini-music']}>
						<MiniPlayerControls
							announceStatus={false}
							mode='music'
							title='参考音乐标题'
							artist='原上传者'
							playing={false}
							buffering={false}
							error=''
							position={30}
							duration={180}
							onOpen={noop}
							onToggle={noop}
							onQueue={noop}
							layoutRevision={revision}
							onStatusChange={reports['mini-music']}
						/>
					</ProbeScope>
					<ProbeScope report={reports['mini-listening']}>
						<MiniPlayerControls
							announceStatus={false}
							mode='listening'
							title='参考视频标题'
							artist='原上传者'
							playing={false}
							buffering={false}
							error=''
							position={30}
							duration={180}
							onOpen={noop}
							onToggle={noop}
							onQueue={noop}
							layoutRevision={revision}
							onStatusChange={reports['mini-listening']}
						/>
					</ProbeScope>
				</HostFooterFrame>
				<View style={{ paddingHorizontal: hostPlayerHorizontalPaddingDp }}>
					<ProbeScope report={reports['music-transport']}>
						<MusicTransportControls
							announceStatus={false}
							playing={false}
							previousDisabled={false}
							nextDisabled={false}
							onOrderInfo={noop}
							onPrevious={noop}
							onToggle={noop}
							onNext={noop}
							onQueue={noop}
							layoutRevision={revision}
							onStatusChange={reports['music-transport']}
						/>
					</ProbeScope>
					<ProbeScope report={reports['listening-transport']}>
						<ListeningTransportControls
							announceStatus={false}
							speed={1}
							playing={false}
							switching={false}
							onSpeed={noop}
							onBackward={noop}
							onToggle={noop}
							onForward={noop}
							onParts={noop}
							layoutRevision={revision}
							onStatusChange={reports['listening-transport']}
						/>
					</ProbeScope>
					<ProbeScope report={reports['common-button']}>
						<ControlRow
							announceStatus={false}
							controlMinWidthsDp={[48]}
							single
							layoutRevision={revision}
							onStatusChange={reports['common-button']}
						>
							<Button onPress={noop}>参考按钮</Button>
						</ControlRow>
					</ProbeScope>
					<ProbeScope report={reports.progress}>
						<Progress
							announceStatus={false}
							position={30}
							duration={180}
							onSeek={noop}
							disabled
							layoutRevision={revision}
							onStatusChange={reports.progress}
						/>
					</ProbeScope>
				</View>
			</ThemeRendererProvider>
		</View>
	)
}
