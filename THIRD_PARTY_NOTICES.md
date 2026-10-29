# 第三方代码与素材声明

审查日期：2026-10-29；适用版本：0.19.4 Build 35。此清单区分已核对证据与检查边界，**不是“所有素材均获授权”的声明**。

## 已确认的代码许可

| 组件 / 路径 | 来源与许可 | 分发处理 |
| --- | --- | --- |
| BBPlayer；`android-app/` 上游基座 | [固定提交 e0ad9bae 的 LICENSE](https://github.com/bbplayer-app/BBPlayer/blob/e0ad9bae2ef7b55a21ed49636043b167e40ed008/LICENSE)，MIT，Copyright (c) 2025 Roitium. | [原文](android-app/LICENSE)与上游逐字核对（忽略换行差异），保留版权与许可。音绘对产品入口、界面和原生能力作了修改，不代表上游官方发行。 |
| `packages/logs` | MIT，Copyright (c) 2021 Alessandro Bottamedi. | 保留 [独立 LICENSE](android-app/packages/logs/LICENSE) 及源文件头。 |
| 酷我 / 汽水 / 酷狗目录适配 | [PlaylistOut 固定提交 a90e1a7f](https://github.com/LengxiQwQ/playlistout/tree/a90e1a7f0a32f020c1e03829570673f993669c63/worker/src/providers)，MIT，Copyright (c) 2026 LengxiQwQ | 参考并改编公开目录端点、字段和分享页 JSON 提取方式；保留 [完整 MIT](licenses/playlistout-MIT.txt) 及应用离线声明。改为有界读取、严格来源 / 分页 / 总数核对，不引入其登录、代理服务或音频功能。 |
| `src/lib/api/netease/{crypto,request,utils}.ts` | 文件头声明来自 [NeteaseCloudMusicApiBackup](https://github.com/nooblong/NeteaseCloudMusicApiBackup)；[MIT](https://github.com/nooblong/NeteaseCloudMusicApiBackup/blob/main/LICENSE)，Copyright (c) 2013-2022 Binaryify | 补入 [完整许可](licenses/NeteaseCloudMusicApi-MIT.txt)，许可证 blob `638a26fdf3bce974b2a5dfeb0786b2db62c662cf`。直接来源已固定到 BBPlayer `e0ad9bae`；crypto / utils 的 Git blob 分别为 `843f056b4bccef2459daba1fd46cb1df653cbfc5` / `a85ec6f381aabfb240464fa643b9fad74022dee5`，与本项目一致。request 有本项目修改；另核对 Netease 上游固定版本 `ed28a571a6965f7164fd81b5c4b41098dbe624d4` 的相同 MIT 原文与移植来源；代码按修改后的 TypeScript 移植披露，不声称与原始 JavaScript 逐字一致。 |
| `packages/react-native-bottom-tabs` | Callstack 1.4.0；固定 npm gitHead `1bbcaa2ea50b61f5daa6ccb8fe9669188c982864`；MIT，Copyright (c) 2024 Callstack | 保留 [版本许可原文](licenses/vendored/bottom-tabs-1.4.0-MIT.txt)。逐文件比对 41 项一致、20 项修改、1 项本地新增；固定上游树未发现 NOTICE。详见 [来源记录](release/vendored-sources.json)。 |
| Orpheus 内 `io/github/proify/lyricon/lyric` | Orpheus README 指向 [tomakino/lyricon](https://github.com/tomakino/lyricon)；本地文件头：Copyright 2026 Proify, Tomakino；[上游 Apache-2.0](https://github.com/tomakino/lyricon/blob/master/LICENSE) | 保留全部文件头及 [Apache-2.0 正文](licenses/Apache-2.0.txt)。直接来源 BBPlayer `e0ad9bae` 的 model 目录 tree `f5b42e1b83d6770585baaa0faf50c23fc5d39f59` 与本项目完全相同；进一步核对固定 Lyricon 版本 `c93da0eef8b7aee015d2670b48e9e262fcf72cd1`，model 子树完全一致；该完整树没有 NOTICE。补存 [版本许可](licenses/vendored/lyricon-Apache-2.0.txt)。 |

完整已审声明通过应用内离线许可页提供，按条目展开。实际打包依赖必须通过 [版本 / 摘要清单](release/dependency-licenses.json) 检查；新增版本、未知二进制或许可文本变化会使 CI 失败。冻结锁文件不能代替分发审查。

旧 Build 33 的 [依赖证据](release/dependency-audit.json) 作为历史样本保留。本版本沿用已审的 74 个 npm / 原生源码包、175 个 Maven 坐标及内嵌组件集合，并补齐 8 个 npm 缺失文本、152 份源码附件中的声明和上游聚合许可。实际打包数量及最终结论见同一发行的依赖 / 交付清单，处理细节见 [分发审核](docs/distribution-review.md)。

### LGPL 分发材料

Orpheus 的 Gradle 配置还直接引入 `com.github.HChenX:SuperLyricApi:2.4` 与 `net.jthink:jaudiotagger:3.0.1`。前者已核对 [2.4 标签的 LGPL-2.1](https://github.com/HChenX/SuperLyricApi/blob/2.4/LICENSE)（blob `8000a6faacf471c537530805ab29523c7732e11a`），补入 [正文](licenses/LGPL-2.1.txt) 和应用内声明；后者的 [作者官网](https://jthink.net/jaudiotagger/) 明确采用 LGPL，3.0.1 官方 Maven Central POM 与源码头现已核对为 LGPL-2.1-or-later，551 个 Java 源文件已用 JDK 17 / Java 8 target 成功重建。

**不能只凭 BBPlayer 的 MIT 许可证放行整个 APK。** 必须确定最终包中这些库的版本与链接形式，提供适用的对应源码、修改说明以及满足相关 LGPL 条件的替换 / 重新链接途径或其他有效方案。两个库的对应源码及材料摘要已准备，见 [LGPL 分发与重新构建说明](docs/lgpl-distribution.md)。SuperLyricApi 2.4 固定提交的全部 24 个文件已逐 blob 核实；Jaudiotagger 3.0.1 官方源码包已编译验证。两库替换后的整包重建和 DEX 验证已有成功证据，当前头仍须重跑，并将最终 APK 与相应源码及许可材料绑定。CI 通过不代表设备验收完成。

维护者已于 2026-10-28 确认 MeloCanvas 自有代码及明确标注 MIT 的原创素材使用根目录 [MIT](LICENSE)。OC 立绘和八态贴纸随后明确改为 [专用素材许可](android-app/apps/mobile/melo/assets/mascot/LICENSE.txt)：仅允许随音绘使用和分发，其他用途须经维护者许可，不适用 MIT。第三方内容继续原许可，既有 CC0 示例授权保持有效。

## 视觉资产清单

| 资产 | 已找到的证据 | 结论 / 待办 |
| --- | --- | --- |
| `design-prototype/assets/coast.png`、移动端同名封面 | [生成记录](design-prototype/assets/art-provenance.md)：无参考图的 AI 海岸场景 | 有项目内来源记录；不是实际唱片封面或平台授予的内容许可。 |
| `design-prototype/assets/*.svg` 几何封面、植物 / 星轨装饰、listen 系列 | 生成脚本与项目原创说明 | 保留原稿和来源，不能把示意节目 / 艺人当真实内容推荐。 |
| 移动端 `melo/assets/{meadow,orbit,cosmos}.png`、图标及 Android 启动 / 通知图 | 原 SVG 字节一致的 PNG 重绘证明、恢复的 cosmos 几何脚本、维护者 MIT 授权 | 自有主素材已补证；逐文件摘要见 [清单](release/asset-audit.json)，旧 Expo 默认图与其他上游素材继续单独核验。 |
| `theme-packages/example` / `paper-signal.melotheme` | 示例许可证声明原创几何，CC0-1.0 | 保留现有声明；归档内文件与原稿还需随最终包核验。 |
| `cosmos-example`、`starter-examples`、`progress-example` | 构建脚本从已核实的原创图片生成 | 官方示例已重建并嵌入完整 MIT；普通用户自行选择的背景图片不自动获 MIT 授权。 |
| 移动端 `melo/assets/support/{wechat.png,alipay.jpg}` | 已有作者支持记录确认由维护者主动提供用于展示 / 分享，文件摘要有记录 | 属于作者有意提供的公开联系 / 支持资料，不作为意外凭据删除；公开前由维护者复核收款人及二维码仍正确。不要复制上游作者的打赏入口作为音绘入口。 |
| BBPlayer 旧图标、头像、Lottie，以及三个 PNG 测试夹具 | 本轮以自有图标 / 原创几何 / 合成像素替换 18 个文件，保留生成脚本与摘要 | 不再分发这些未知来源原图；两个上游收款码从公开集合排除，对应旧弹窗改为核实上游支持方式的提示。该处理不是对原素材的追溯授权；见 [生成记录](design-prototype/assets/art-provenance.md)。 |
| 原始设备截图、平台封面、B 站装扮、实验附件 | 含实际界面 / 内容，可能同时暴露测试者资料 | 从当前 Git 树撤下原始证据与参考截图；历史仍在，不可直接公开整个现有仓库。 |

播放或导入时从 B 站及歌词服务取得的音视频、歌词、字幕、封面、装扮和商标属于相应权利人。按账号可访问不等于取得再分发许可；主题导出、备份和截图也不转移这些权利。不要将私人收藏、下载文件、商业主题或完整歌词作为公开示例、测试夹具或发行附件。

公开源码中的两份上游实际歌词响应夹具已撤下，替换为合成 YRC；其中账号元数据与整首歌词不随快照分发。此前已公开的歌词或图片也不能仅凭可访问就当作自由许可素材。
