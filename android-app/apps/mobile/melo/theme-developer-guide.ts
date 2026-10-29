import { authorContact } from './app-information'

export const themeDeveloperLinks = {
	project: authorContact.project,
	releases: 'https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases',
} as const

export const themeDeveloperGuide = [
	{
		title: '收藏集背景、挂件与方向滑块',
		text: '声明 collection-art-v1 与 backgrounds 必需能力，可在 decorations.profileBackground 指定个人页背景，avatarFrame 指定透明头像框 PNG；挂件以 88 dp 画布叠加在居中 50 dp 圆形头像外，请按此比例留出透明开口；不修改用户头像文件。components.progress.thumb 可增加 dragLeft、dragRight 静态 PNG 路径，拖动时切换，松手恢复 light 图片；仍需 custom-progress-v1。这些扩展资源只在浅色模式使用，深色缺少配置时整体回退宇宙。B站导入按皮肤所属收藏集读取独立奖励，可从同套图片选择背景、调整壁纸透明度与取景，确认后在导入阶段合成静态 PNG；不运行视频或循环动画。',
	},
	{
		title: '浅色、深色与跟随系统',
		text: '在“我的 → 设置 → 显示 → 明暗模式”选择浅色、深色或跟随系统，默认跟随系统。内置深色外观为宇宙：黑底、深灰卡片，无持续动画。没有 dark 配置的第三方主题（包括普通壁纸与 B站导入主题）整体回退为宇宙，不把浅色壁纸强行淡化。原主题仍保存在已安装列表，切回浅色自动恢复。',
	},
	{
		title: '制作同时支持明暗的主题',
		text: '在 tokens.json 保留完整 light，同时增加完整 dark，不能只写差异字段；在 manifest 的 requiredCapabilities 或 optionalCapabilities 声明 dark-tokens。dark 使用与 light 相同的语义组，可单独设置 progress.track/fill/thumb 和歌词颜色。图标的 dark 状态、滑块 thumb.dark 需单独提供，缺失时使用宿主图标或颜色滑块。当前 hero/backdrop 图片与组件布局由两个模式共用，因此应选择明暗都可读的资源，或省略 backdrop 使用各自底色；深色图片不会自动反色或淡化。完整源文件见 theme-packages/cosmos-example，可导入样例为 starter-examples/cosmos-dual.melotheme。',
	},
	{
		title: '开发者模式能做什么',
		text: '用声明式主题包调整配色、组件变体、背景、图标与支持的布局规则。主题包不能运行 JavaScript、加载任意网页或替换应用功能。普通壁纸调整用上方工具即可；开发者可继续修改导出的文件，或在电脑使用项目的构建工具。',
	},
	{
		title: '深色主题验收',
		text: '创作者可在自己的 GitHub Releases 发布同时含 light/dark 的 .melotheme，导入后按用户的明暗模式自动选用。未提供 dark 时使用宇宙；提供了格式不完整的 dark 会拒绝导入并保留原主题。请分别在浅色和深色模式下预览主题，再检查同步歌词、歌词设置弹窗、搜索框提示文字、播放菜单、导入失败提示，以及图标和滑块缺少深色图片时的回退。反复切换不应触发素材下载或图片重新合成。',
	},
	{
		title: '从样例开始',
		text: '选择原色、森间或星轨，调整壁纸后导出 .melotheme。项目 theme-packages/starter-examples 提供三套简化样例；theme-packages/example 提供带 source.json 的作者源文件。仓库中的 docs/theme-package-foundation.md、docs/theme-responsive-contract.md、docs/theme-icon-resources.md 解释格式与扩展能力；能力是否可用以当前应用导入检查为准。',
	},
	{
		title: '主题包的文件结构',
		text: '.melotheme 是 ZIP：根目录包含 manifest.json、tokens.json、components.json、LICENSE.txt；静态 PNG 放在 assets/，预览图放在 previews/。不要再套一层目录。manifest 必须提供 format="melocanvas-theme"、schemaVersion=1、唯一 id（如 example.my-theme）、SemVer version、name、author、minAppVersion、license、entry、fallback、requiredCapabilities、optionalCapabilities、assets 和 previews。entry 指向两个 JSON，fallback 使用 melocanvas.builtin.modern。',
	},
	{
		title: '配色与可读性',
		text: 'tokens.json 的 light 包含完整的 surface(base/card/tinted)、text(primary/secondary/inverse)、action(primary)、state(error)、border(subtle/strong)、lyric(active/inactive)。颜色使用 #RRGGBB。先确保正文、次要文字和歌词能从背景中读清，再调整强调色。检查浅色照片、深色照片、空列表、错误提示和长标题；不要只检查首页。',
	},
	{
		title: '组件与背景',
		text: 'components.json 内 components.card/button/input 使用支持的 rounded、leaf、comic 变体；button.minTouchDp 至少 48。navigation.discoverIcon 为 home/flower/star；player.frame 为 square/arch/tilted；progress.variant 为 modern/pastoral/anime。decorations.backdrop 指向包内背景 PNG，hero 可单独指定。首页主视觉 banner 与底部导航背景 navigation 也可引用静态 PNG，需声明 surface-art-v1 必需能力及 backgrounds；主视觉按 8:5 区域裁切显示，导航背景铺满底栏。decorations.pageHeader 为搜索、音乐库、我的等浏览页的紧凑顶部装饰；播放器和歌词页不显示，声明同样的能力。motion.durationMs 为 0–500，respectReducedMotion 必须为 true。上方工具会把透明度、缩放和取景位置合成进静态 PNG；手工开发可直接设计最终背景。',
	},
	{
		title: '进度条与滑块',
		text: '开发者模式可分别设置底轨、已播放部分和滑块颜色，并选择透明 PNG 滑块。tokens.json 的 light.progress 使用 track、fill、thumb 三个 #RRGGBB 颜色；深色主题在 dark.progress 单独配置。components.progress 保留 variant，可增加 thumb: {"light":"assets/thumb.png","sizeDp":28}，需要深色图片时增加 dark 路径。图片最大 256×256、256 KiB，显示尺寸 16–40 dp，保留至少 48 dp 的触控区域。图片不染色、不旋转；加载失败或深色图片缺失时回退为颜色滑块。必须声明 custom-progress-v1 必需能力，旧版应用会明确拒绝而非错误显示。',
	},
	{
		title: '自定义进度条样例',
		text: 'theme-packages/starter-examples/modern-custom-progress.melotheme 是可导入样例；theme-packages/progress-example 提供可编辑的 source.json、tokens.json、components.json、静态图片和授权说明。三套基础样例仍保持简洁。开发者模式导出包含进度条设置；上方“保存并应用外观”仅保存基础配色和壁纸，高级主题请导出后通过工坊预览并应用。',
	},
	{
		title: 'B站个性主题导入',
		text: '在工坊打开“从 B站导入个性主题”，登录后点击“读取我的 B站主题”，可导入账号已拥有的个性主题，包括商城搜不到的收藏集奖励；也可搜索商城装扮或收藏集。点击结果下载并预览，再应用。适配首页主视觉、静态背景、底部导航背景、发现/搜索/音乐库/我的图标和进度条；单独读取已拥有的个性主题不包含收藏集的独立进度条奖励。搜索底栏使用同套主题的动态页静态图标，输入框仍保留放大镜；各页面和播放器使用紧凑顶部装饰，并从主题强调色生成配套底色。多套资源使用首套可用外观。浅色强调色保留在进度条，按钮会调整为清晰可读的同色系。下载图片只在导入时缩小并转成 PNG，动画素材只取静态帧，不加载启动视频、SVGA、Lottie 或持续动画。导入后保存在已安装主题中，可离线切换和撤销，不改变 B站账号的装扮。原素材版权与授权不因适配改变，发布原创主题时请使用有权分发的资源。',
	},
	{
		title: '图片与资源清单',
		text: '最终包只使用静态 PNG，不直接携带 SVG、字体或可执行脚本。每张图片都需在 manifest.assets 中声明 path、mime="image/png"、实际 bytes 和 SHA-256；预览图也必须登记。修改图片后要重新生成清单。建议壁纸使用 720×1280 或接近屏幕的尺寸，避免密集矢量纹理和超大图片。应用会检查资源完整性、图片解码和包体限制（包不超过 20 MiB，单文件不超过 8 MiB）。',
	},
	{
		title: '在电脑构建和校验',
		text: '准备项目已有的 pnpm 依赖、Node.js 与 Sharp 图片解码器。作者目录使用 source.json（manifest 元数据、images 输出路径到本地图片的映射）、tokens.json、components.json、LICENSE.txt 和图片源文件。在仓库根执行：\nnode scripts/theme-package.cjs build theme-packages/example my-theme.melotheme\nnode scripts/theme-package.cjs validate my-theme.melotheme\nnode scripts/theme-contrast.cjs my-theme.melotheme\n需要时用 MELO_THEME_SHARP 指向已安装的 Sharp。构建工具会转换图片、更新长度和哈希；颜色检查仅覆盖可计算的纯色组合，不代替手机预览。',
	},
	{
		title: '扩展能力与验收',
		text: 'requiredCapabilities 只声明主题真正依赖的能力；缺少必需能力时应用会拒绝导入。自定义图标查阅 package-icons-v1，紧凑布局查阅 responsive-touch-layout-v1，不要通过未知字段绕过检查。最终在应用内检查首页、搜索、音乐库、播放器、歌词、队列、长文本和大字体，并验证返回、切换主题与撤销；不要用主题控件遮住播放或返回操作。',
	},
	{
		title: '作者在哪里发布',
		text: '作者自行托管主题文件，无需提交给音绘或打进 APK。推荐在自己的 GitHub 仓库创建 Release，附上 .melotheme、预览图、版本号、兼容应用版本、更新说明和图片授权信息。也可发布到个人网站或网盘，在社区帖子中分享下载链接。请提供最终主题包，不能只给 GitHub 自动生成的源码 ZIP。主题更新由作者发布新版本，用户下载后再次导入。',
	},
	{
		title: '用户如何获取',
		text: '从作者发布页下载 .melotheme 到手机，再回到主题工坊“从文件导入主题”，确认预览后应用。音绘当前不提供主题商城、在线文件托管或自动更新；应用只管理内置样例、本机外观和已安装的主题。',
	},
] as const
