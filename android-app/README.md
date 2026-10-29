# MeloCanvas Android 工程

这是音绘的源码工作区，基于 BBPlayer 固定提交派生。**音绘首个公开 Beta 为 0.19.4 Build 35。** 发行材料、安装包校验和已知限制以仓库根目录说明为准。

- 产品范围与状态：[仓库 README](../README.md)
- 普通用户安装：[INSTALL.md](../INSTALL.md)
- 隐私与本机资料：[PRIVACY.md](../PRIVACY.md)
- 开发构建：[Android 构建指南](../docs/android-build.md)
- 上游维护：[来源与迁移](../docs/upstream.md)
- 授权：[BBPlayer MIT 原文](LICENSE) 与 [第三方声明](../THIRD_PARTY_NOTICES.md)

使用仓库指定的 Node / pnpm 版本，在本目录执行 `pnpm install --frozen-lockfile --ignore-scripts`、`pnpm type-check`、`pnpm lint`。产品入口是 `apps/mobile/index.js`，包名为 `org.melocanvas.app`。

工作区保留的 BBPlayer 旧页面、服务端、文档站和工具不代表音绘已经提供这些服务。上游 npm package 版本不等于音绘 APK 版本。不要从 BBPlayer 的 Releases 下载音绘，也不要把上游维护者的联系与打赏信息作为音绘渠道。

原始上游说明可在 [BBPlayer 固定提交](https://github.com/bbplayer-app/BBPlayer/tree/e0ad9bae2ef7b55a21ed49636043b167e40ed008) 查看。
