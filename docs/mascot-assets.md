# 音绘看板娘与品牌素材

2026-10-28 接入维护者提供的暂定 OC、音绘图标和八态贴纸。维护者明确将 OC 立绘与八态贴纸改为 [专用素材许可](../android-app/apps/mobile/melo/assets/mascot/LICENSE.txt)：仅允许随音绘使用和分发，其他用途须经其许可。角色归属为 MeloCanvas 维护者（GitHub: lxiaodong681-lab）；原画包含 AI 生成内容，整理使用 AI 辅助编辑。自有代码及本次应用图标继续采用 MIT；第三方内容不因此重新授权。

## 来源与处理

- `melo/assets/mascot/portrait.png`：维护者提供的白底 OC 立绘原稿，原文件逐字节保留，不直接用于开屏。
- `melo/assets/mascot/portrait-cutout.png`：按维护者要求使用内置 imagegen 移除白底，保留人物并输出透明 alpha。浅色 / 深色开屏都直接展示此图，没有白色画框，不拉伸人物。
- `melo/assets/icon.png`：维护者提供的 1024×1024 透明圆角图标，原文件逐字节保留。
- `melo/assets/icon-foreground.png` 和 Android launcher / splash 密度资源：由 `node scripts/prepare-brand-assets.cjs` 使用锁定依赖生成。前景图加入自适应图标安全留白，避免圆形遮罩截断主图形。
- `melo/assets/mascot/{playing,video,loading,empty,search,error,liked,sleep}.png`：以维护者提供的八态图为唯一图像参考，使用内置 imagegen 分别整理为独立透明图。维护者明确允许重新整理透明边缘及轻微画面变化。保留原稿动作、道具及角色特征；完整提示词见 [生成说明](mascot-prompts.md)。

路径均相对于 `android-app/apps/mobile`。原始拼图、弃用生成稿及私人生成记录不进入公开快照。当前图标已替换旧图标；相邻旧 `icon.svg` 仅为此前原创几何源稿，不是新图标的生成源。文件摘要见 [品牌素材清单](../release/brand-assets.json)。

## 实际显示位置

| 素材 | 位置与行为 |
| --- | --- |
| OC 立绘 | 账号恢复、外观恢复和首次布局准备时的应用开屏；准备好立即退出，无最低展示时间 |
| 音绘图标 | Android 系统启动图标、桌面图标及应用开屏品牌区 |
| 戴耳机听歌 | 播放器正在播放时的小幅装饰；暂停时隐藏 |
| 抱视频屏幕 | 听视频无收听记录的引导 |
| 推唱片 | 搜索加载、播放器缓冲状态 |
| 空唱片盒 | 空音乐库、空歌单及空喜欢列表 |
| 放大镜 | 搜索入口和无匹配结果 |
| 断开音频线 | 搜索失败、歌单读取失败和播放异常 |
| 抱爱心 | 喜欢列表的栏目装饰；不冒充未成功的收藏反馈 |
| 睡在尾巴上 | 定时暂停面板；实际定时状态仍由文字和原生播放器控制 |

贴纸不截获点击，不替代状态文字、重试或播放按钮，不向读屏重复朗读装饰内容。全部图片随应用打包，展示它们不发起网络请求。Android 12 及以上的系统启动阶段仍遵循系统图标布局；完整立绘在 React Native 初始化页显示。

布局预览和组件测试不等于正式签名 APK 的真机验收；具体版本、发行材料及验证边界见 [版本说明](public-beta-status.md)。
