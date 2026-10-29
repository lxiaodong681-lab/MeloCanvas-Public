export const authorContact = {
	name: 'lxiaodong681-lab',
	email: 'lxiaodong681@gmail.com',
	github: 'https://github.com/lxiaodong681-lab',
	project: 'https://github.com/lxiaodong681-lab/MeloCanvas-Public',
	issues: 'https://github.com/lxiaodong681-lab/MeloCanvas-Public/issues',
} as const

export const usageStatements = [
	{
		title: '项目性质与费用',
		text: '音绘以学习交流为目的，免费提供，不收取下载、登录或功能使用费用，不设置付费解锁。项目目的不代替第三方内容授权，也不改变适用法律及开源许可证的规定。',
	},
	{
		title: '非官方客户端',
		text: '音绘是非官方 B 站音乐客户端，与哔哩哔哩官方无隶属关系。使用前需要登录 B 站账号。',
	},
	{
		title: '内容权利与使用范围',
		text: '音视频、歌词、字幕、封面及商标等权利归相应权利人所有。请遵守来源平台规则，仅在法律和权利人许可范围内播放、缓存及导入内容，不得擅自转载、售卖或公开传播。软件源码的许可不等于第三方内容许可；本应用不提供绕过付费、地区或账号权限限制的功能。',
	},
	{
		title: '账号与本机资料',
		text: '账号会话用于连接 B 站服务，保存在本应用的系统安全存储中，不放入音乐备份。不读取你浏览器的登录资料，也不要求输入 B 站密码。',
	},
	{
		title: '联网与第三方服务',
		text: '搜索、播放、收藏夹和关注等在线操作会向 B 站发起相应请求；在线歌词匹配会向已有歌词提供方发送歌曲查询信息。第三方服务按各自规则处理请求。歌单、偏好及播放记录主要保存在本机；备份与清理范围见“隐私与本机数据”和音乐库备份说明。',
	},
	{
		title: '服务限制与责任',
		text: '内容和字幕可能受账号权限、平台限制或接口变化影响。登录不代表取得下载、转载或公开分发许可；本说明不免除开发者应承担的责任。当前为 0.19.4 Build 35 公开 Beta，功能及兼容性仍需测试；请核对官方发行说明、安装包摘要和已知限制，并保留重要资料备份。本说明不排除或限制依法不得排除、限制的责任或用户权利。',
	},
	{
		title: '自愿打赏',
		text: '打赏完全自愿，不是软件使用费，不影响任何功能，也不对应额外功能或特定服务。请在微信或支付宝内核对收款信息和金额后自行决定。音绘只展示或分享收款码，不处理支付订单，不读取支付账号、金额或交易记录。',
	},
	{
		title: '维护与反馈',
		text: `项目由 GitHub 用户 ${authorContact.name} 维护。问题或建议可提交至项目 Issues，也可联系 ${authorContact.email}。涉及权利或隐私的问题，请提供相关内容地址、问题说明及必要证明；不要发送账号密码或会话凭据。反馈不会自动附带本机资料。`,
	},
] as const

export const accountUsageNotice = usageStatements.map(({ text }) => text)
