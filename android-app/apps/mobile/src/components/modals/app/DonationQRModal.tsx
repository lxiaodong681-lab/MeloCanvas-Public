import { Dialog, Text } from 'react-native-paper'

import Button from '@/components/common/Button'
import { useModalStore } from '@/hooks/stores/useModalStore'

/** The legacy screen must not distribute an unverified payee's QR codes. */
export default function DonationQRModal(_props: { type: 'wechat' | 'alipay' }) {
	const close = useModalStore((state) => state.close)
	return (
		<>
			<Dialog.Title>上游项目支持</Dialog.Title>
			<Dialog.Content>
				<Text>上游收款码不随音绘分发。如需支持 BBPlayer，请通过其官方项目页面核实作者与支持方式。</Text>
			</Dialog.Content>
			<Dialog.Actions>
				<Button onPress={() => close('DonationQR')}>关闭</Button>
			</Dialog.Actions>
		</>
	)
}
