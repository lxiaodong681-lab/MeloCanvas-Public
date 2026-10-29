# 音绘 MeloCanvas

面向 B 站内容的非官方 Android 音乐 / 听视频客户端，基于 [BBPlayer](https://github.com/bbplayer-app/BBPlayer) 开发。音绘与哔哩哔哩、BBPlayer 的维护者均无官方隶属或背书关系。

**首个公开 Beta：0.19.4 · Build 35。** 这是早期测试版，功能与机型兼容性仍需测试；版本号本身不代替安装包校验。发行材料和验证边界见 [版本说明](docs/public-beta-status.md)。

## 可以做什么

- 使用 B 站扫码登录，搜索和播放当前账号有权访问的内容。
- 分别管理音乐与听视频队列，切换分 P、章节、字幕，使用睡眠定时。
- 管理本机喜欢、歌单、最近播放和本地音频；按权限读取收藏夹，选择性导入关注。
- 从网易云 / QQ / 酷我 / 汽水公开歌单读取歌曲目录并匹配 B 站音源；酷狗分享页目前可能只返回限量预览，应用会提示未读完整。新增来源需完整链接，匹配仍需自行核对，详见 [导入与心动推荐](docs/music-discovery.md)。
- 私人 FM 可按已导入歌单查找一批心动候选（试验）；主要参考歌单，最近播放只作低权重参考。它基于 B 站关键词查找，不是网易云的推荐模型。
- 查看本地或在线歌词，使用内置外观和主题包，导出 / 恢复音乐库备份。

内容可用性、歌词准确性、登录和离线播放会受账号权限、平台接口和设备影响。下载只适用于已获许可且应用能够读取的内容；离线入口也有已有会话及完整文件等条件。首次使用需要联网和 B 站账号。本项目不提供独立曲库、云端音乐库同步，也不提供绕过付费、地区或账号权限限制的功能。

## 安装与反馈

候选目标为 **Android 8.0（API 26）及以上、ARM64（arm64-v8a）**。x86_64 用于开发模拟器，不等同于 ARM 手机兼容性验证；没有 iOS 或桌面安装版。

长期公开仓库为 [MeloCanvas-Public](https://github.com/lxiaodong681-lab/MeloCanvas-Public)。仅从其 [Releases](https://github.com/lxiaodong681-lab/MeloCanvas-Public/releases) 中明确标为 **0.19.4 Build 35 公开 Beta** 的条目下载，核对同条目提供的 SHA-256 和签名证书摘要。旧内部包及 CI 未签名产物不能代替发行包。安装、校验、升级和锁屏通知常见问题见 [安装指南](INSTALL.md)。

测试版可能出现播放、登录、主题、耗电和数据兼容问题。安装前导出重要资料，并确认备份已经保存到应用以外的位置。音绘免费使用；自愿打赏不解锁功能，也不构成稳定性或维护承诺。

问题或建议请提交到 [公开 Issues](https://github.com/lxiaodong681-lab/MeloCanvas-Public/issues)。反馈请注明版本 / Build、Android 版本、机型、复现步骤和预期结果。截图请遮盖头像、昵称、收藏夹和二维码；不要上传 Cookie、登录二维码、完整日志、备份或设备序列号。涉及隐私或安全的问题请按 [安全反馈说明](SECURITY.md) 私下联系。

## 隐私与授权

- [MeloCanvas MIT 许可证](LICENSE)：覆盖自有代码及明确标注 MIT 的素材；第三方和既有 CC0 授权保持原许可。
- [OC 素材专用许可](android-app/apps/mobile/melo/assets/mascot/LICENSE.txt)：看板娘立绘及八态贴纸由维护者保留权利，仅允许随音绘使用和分发，其他用途须另行取得许可；不适用 MIT。
- [隐私说明](PRIVACY.md)：本机资料、第三方请求、备份与删除范围。
- [第三方声明与素材清单](THIRD_PARTY_NOTICES.md)：源码许可与图片、音视频、歌词、字幕等内容权利分别处理。
- [BBPlayer MIT 许可证](android-app/LICENSE)：保留原作者版权与完整许可文本。项目的学习交流目的不缩减 MIT 授予的权利，也不授予任何第三方内容的传播许可。

## 源码与开发

正式入口为 `android-app/apps/mobile/index.js` → `melo/account-root.tsx`，包名为 `org.melocanvas.app`。版本以 `app.config.ts` 与已提交 Android Gradle 配置为准；上游 workspace 的 package.json 版本不是音绘安装包版本。

按仓库 `.node-version` 安装 Node，使用 `android-app/package.json` 指定的 pnpm。在 `android-app/` 执行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm type-check
pnpm lint
```

构建、签名、工具链与 CI 见 [Android 开发构建指南](docs/android-build.md)，上游来源见 [BBPlayer 维护说明](docs/upstream.md)。正式更新必须保留签名身份。用户可按 [LGPL 重建说明](docs/lgpl-distribution.md) 修改依赖并自行签名安装；自签名不等于官方覆盖更新。开发记录不是面向用户的发行说明，原始设备证据应留在私有存储中。
