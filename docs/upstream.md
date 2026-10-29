# BBPlayer 上游来源

`android-app/` 基于 BBPlayer 固定提交 [e0ad9bae2ef7b55a21ed49636043b167e40ed008](https://github.com/bbplayer-app/BBPlayer/tree/e0ad9bae2ef7b55a21ed49636043b167e40ed008)。[原 MIT 许可](../android-app/LICENSE)与上游文本逐字核对（忽略换行差异），保留 Copyright (c) 2025 Roitium。MeloCanvas 自有代码和原创素材采用根目录 MIT；第三方文件保留原版权和许可。

公开候选采用无旧历史快照，不包含私有库的 subtree 历史。后续更新须在私有开发库审查上游变化、移植补丁并验证，再导出新的文件集合；不能在公开快照中直接假设存在原 subtree 提交。

正式入口为 `android-app/apps/mobile/index.js` → `melo/account-root.tsx`。`melo/` 是音绘产品层，旧 `src/` 保留可复用实现，未开放的旧页面不是音绘功能承诺。Orpheus 播放器、原生模块、锁文件、Expo 插件和 Android 工程均随源码提供。

音绘修改包括产品入口、账号和隐私边界、队列、主题、通知、原生播放及构建适配。原上游运营者、更新、Firebase/Sentry 与其他旧功能不代表当前音绘行为，见[隐私说明](../PRIVACY.md)。代码和素材的具体归属、尚未完成的核验见[第三方声明](../THIRD_PARTY_NOTICES.md)。

上游升级后须重跑类型检查、lint、移动端回归和受影响原生包 build，并按风险补设备验收；不得用旧历史日志替代本次产物的验证。
