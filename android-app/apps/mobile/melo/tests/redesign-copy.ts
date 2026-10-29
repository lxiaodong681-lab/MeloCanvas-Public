/** Only reviewed wording changes are applied to historical UI fixtures.
 * Native structure, values, disabled states and callbacks remain comparable. */
export function approvedRedesignCopy(source: string) {
	const changes = [
		[
			'同一段声音，三种风景。切换主题会保留收听与进度。',
			'切换主题保留收听进度。',
		],
		[
			'同一首歌，三种风景。切换主题会保留播放与喜欢。',
			'切换主题保留当前播放和收藏。',
		],
		['暖白 / 留白 / 叠放唱片', '暖白与朱红'],
		['草木 / 叶形纸片 / 拱形封面', '米白与草木绿'],
		['星轨 / 漫画描边 / 倾斜相片', '浅紫与紫罗兰'],
		['故事、见闻，和另一种陪伴。', '收藏视频，继续收听与管理进度。'],
		['让喜欢的声音\\n陪你慢慢生活', '设置音乐偏好'],
		['给这段心情起个名字', '输入歌单名称'],
		['写下这张歌单的故事，也可以留空', '输入歌单简介（选填）'],
	] as const
	for (const [before, after] of changes)
		source = source.replaceAll(before, after)
	return source
}
