import { Image } from 'expo-image'
import React, { useEffect, useRef, useState } from 'react'
import {
	Linking,
	Modal,
	ScrollView,
	Text,
	useWindowDimensions,
	View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { authorContact, usageStatements } from './app-information'
import { openSourceNotices } from './open-source-notices'
import {
	shareSupportCode,
	supportCodes,
	type SupportChannel,
} from './author-support-mobile'
import { PageHeader, SettingsRow } from './settings-layout'
import { Backdrop, Button, Card, ControlTarget, shape, T, useTheme } from './ui'

export function AuthorSupportEntry() {
	const theme = useTheme()
	const c = theme.tokens
	const insets = useSafeAreaInsets()
	const { fontScale } = useWindowDimensions()
	const [page, setPage] = useState<'contact' | 'support' | 'notice' | 'licenses' | null>(
		null,
	)
	const [channel, setChannel] = useState<SupportChannel>('wechat')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState('')
	const [imageFailed, setImageFailed] = useState(false)
	const [expandedLicense, setExpandedLicense] = useState<number | null>(null)
	const pending = useRef(false)
	const generation = useRef(0)
	useEffect(
		() => () => {
			generation.current++
		},
		[],
	)
	const navigate = (next: typeof page) => {
		generation.current++
		pending.current = false
		setBusy(false)
		setError('')
		setImageFailed(false)
		setExpandedLicense(null)
		setPage(next)
	}
	const run = async (action: () => Promise<unknown>, failure: string) => {
		if (pending.current) return
		pending.current = true
		const current = generation.current
		setBusy(true)
		setError('')
		try {
			await action()
		} catch {
			if (current === generation.current) setError(failure)
		} finally {
			if (current === generation.current) {
				pending.current = false
				setBusy(false)
			}
		}
	}
	const open = (url: string, failure = '暂时无法打开链接，请稍后重试。') => {
		void run(() => Linking.openURL(url), failure)
	}
	const back = () => navigate(page === 'contact' ? null : 'contact')
	const code = supportCodes[channel]
	return (
		<>
			<SettingsRow
				label='联系作者与支持'
				onPress={() => navigate('contact')}
			/>
			{page && (
				<Modal
					visible
					animationType='none'
					onRequestClose={back}
				>
					<View
						style={{
							flex: 1,
							backgroundColor: c.surface.base,
							paddingTop: insets.top,
							paddingBottom: insets.bottom,
						}}
					>
						<Backdrop />
						<PageHeader
							title={page === 'support' ? '支持作者' : page === 'notice' ? '使用与免责声明' : page === 'licenses' ? '许可证与素材权利' : '联系作者'}
							backLabel={page === 'contact' ? '返回' : '返回联系作者'}
							onBack={back}
						/>
						<View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
							{!!error && (
								<Text
									key={fontScale}
									accessibilityRole='alert'
									style={{
										color: c.text.primary,
										fontSize: 14,
										lineHeight: 21,
									}}
								>
									{error}
								</Text>
							)}
						</View>
						<ScrollView
							key={page}
							contentContainerStyle={{
								paddingHorizontal: 20,
								paddingBottom: 24,
								gap: 20,
								width: '100%',
								maxWidth: 540,
								alignSelf: 'center',
							}}
						>
							{page === 'contact' && (
								<>
									<Card style={{ gap: 12 }}>
										<T variant='section'>问题反馈</T>
										<T muted>
											问题或建议可提交 GitHub Issues。无法使用 GitHub
											时，也可通过邮箱反馈。
										</T>
										<Button
											disabled={busy}
											onPress={() => open(authorContact.issues)}
										>
											前往 GitHub Issues
										</Button>
										<Button
											secondary
											disabled={busy}
											onPress={() => open(authorContact.project)}
										>
											查看 GitHub 项目
										</Button>
									</Card>
									<Card style={{ gap: 12 }}>
										<T variant='section'>联系作者</T>
										<T muted>GitHub · {authorContact.name}</T>
										<Text
											key={fontScale}
											selectable
											style={{
												color: c.text.primary,
												fontSize: 15,
												lineHeight: 23,
											}}
										>
											{authorContact.email}
										</Text>
										<Button
											secondary
											disabled={busy}
											onPress={() =>
												open(
													`mailto:${authorContact.email}`,
													'未能打开邮件应用，可长按邮箱地址复制后自行发送。',
												)
											}
										>
											发送邮件
										</Button>
										<Button
											secondary
											disabled={busy}
											onPress={() => open(authorContact.github)}
										>
											访问作者 GitHub
										</Button>
									</Card>
									<Button
										secondary
										onPress={() => navigate('support')}
									>
										请作者喝杯咖啡
									</Button>
									<Button
										secondary
										onPress={() => navigate('notice')}
									>
										使用与免责声明
									</Button>
									<Button secondary onPress={() => navigate('licenses')}>许可证与素材权利</Button>
								</>
							)}
							{page === 'support' && (
								<>
									<T muted>
										软件免费使用。打赏完全自愿，不影响任何功能，也不对应额外功能或特定服务。
									</T>
									<View
										style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}
									>
										{(Object.keys(supportCodes) as SupportChannel[]).map(
											(key) => (
												<ControlTarget
													key={key}
													accessibilityRole='tab'
													accessibilityState={{
														selected: channel === key,
														disabled: busy,
													}}
													disabled={busy}
													onPress={() => {
														setChannel(key)
														setImageFailed(false)
														setError('')
													}}
													style={[
														shape(theme.components.button),
														{
															flex: 1,
															minWidth: 112,
															minHeight: 48,
															padding: 12,
															alignItems: 'center',
															justifyContent: 'center',
															borderWidth: 1,
															borderColor:
																channel === key
																	? c.action.primary
																	: c.border.subtle,
															backgroundColor:
																channel === key
																	? c.surface.tinted
																	: c.surface.card,
														},
													]}
												>
													<T weight={channel === key ? '700' : '400'}>
														{supportCodes[key].label}
													</T>
												</ControlTarget>
											),
										)}
									</View>
									<Image
										key={channel}
										source={code.image}
										contentFit='contain'
										accessibilityLabel={`${code.label}收款码`}
										onError={() => setImageFailed(true)}
										style={{
											width: '100%',
											aspectRatio: code.aspectRatio,
											borderRadius: 12,
											backgroundColor: '#ffffff',
										}}
									/>
									{imageFailed && <T>收款码暂时无法显示，请重新打开此页面。</T>}
									<Button
										secondary
										disabled={busy}
										onPress={() => {
											void run(
												() => shareSupportCode(channel),
												'暂时无法分享收款码，可直接查看图片或稍后重试。',
											)
										}}
									>
										{busy ? '正在打开分享…' : '分享收款码图片'}
									</Button>
									<T
										muted
										size={12}
									>
										可通过系统分享保存或发送图片，再由微信或支付宝识别。支付仅在对应应用内完成，请自行核对收款信息和金额。
									</T>
								</>
							)}
							{page === 'licenses' && (
								<>
									<T muted>许可与版权声明已随应用保存，可离线展开阅读。音绘 OC 使用专用素材许可，其他用途须经作者许可。</T>
									{openSourceNotices.map((section, index) => (
										<View key={section.title} style={{ gap: 8 }}>
											<ControlTarget
												accessibilityRole='button'
												accessibilityLabel={section.title}
												accessibilityState={{ expanded: expandedLicense === index }}
												onPress={() => setExpandedLicense(expandedLicense === index ? null : index)}
												style={{ paddingVertical: 12, gap: 6 }}
											>
												<T variant='section'>{section.title}</T>
												<T muted>{expandedLicense === index ? '收起' : '查看全文'}</T>
											</ControlTarget>
											{expandedLicense === index && <T muted>{section.text}</T>}
										</View>
									))}
								</>
							)}
							{page === 'notice' &&
								usageStatements.map((section) => (
									<View
										key={section.title}
										style={{ gap: 8 }}
									>
										<T variant='section'>{section.title}</T>
										<T muted>{section.text}</T>
									</View>
								))}
						</ScrollView>
					</View>
				</Modal>
			)}
		</>
	)
}
