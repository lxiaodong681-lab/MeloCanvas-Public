# Android 源码构建

发行版本为 0.19.4 Build 35，包名 org.melocanvas.app，最低 Android 8 / API 26，公开目标为 ARM64。构建通过不表示已覆盖全部[设备验收](public-beta-status.md)。测试用户请看[安装指南](../INSTALL.md)。

## 安装依赖与检查

使用 `.node-version` 指定的 Node 22.22.2 和 `android-app/package.json` 指定的 pnpm 11.25.0。在 `android-app/` 执行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm type-check
pnpm lint
```

回到仓库根目录运行 `node scripts/android-ci.cjs test`。主题基线是经过审查的固定源码夹具，不依赖私有 Git 历史；图片测试解码器来自冻结安装的 Expo 工具依赖，不再依赖开发者 vendor 缓存。需要单独检查歌词解析器时执行 `pnpm --dir android-app/packages/splash test --runInBand`。

## 构建未签名 ARM64 包

使用 JDK 17、Android SDK，以及 `node scripts/android-ci.cjs metadata` 从冻结配置解析出的 build-tools、compileSdk、NDK 和 CMake 版本。设置 JAVA_HOME、ANDROID_HOME。CI 的工具链安装命令见 `.github/workflows/android-apk.yml`。保留锁文件和全部原生源码；不要运行自动升级依赖的命令。

从根目录执行：

```sh
node scripts/fix-worklets-lint.cjs
cd android-app/apps/mobile/android
bash ./gradlew :app:assembleRelease :bbplayer-native:build :bbplayer-orpheus:build \
  -PmeloUnsignedRelease=true -PreactNativeArchitectures=arm64-v8a \
  --init-script ../../../../scripts/android-ci.init.gradle \
  --no-daemon --max-workers=2
```

Windows 使用 `gradlew.bat`；现有 Windows 辅助脚本提供 CMake 短路径适配，工具路径须自行配置。SDK、依赖、缓存、local.properties、密钥及构建输出不在源码快照内。Expo 生成的 Android 工程已经提交，日常构建无需重新 prebuild；如需重新生成，必须审查包名、版本、权限、签名及插件生成差异。

未签名包不能直接安装。私有 CI 的 PR 检查只上传未签名检查产物；手动发行构建使用原签名的 Repository Secrets，经验证后保留 APK 摘要与证书摘要。任何公开发布都仍需单独批准。构建辅助程序会检查版本、ARM64、Release/debuggable 状态、JS bundle 和签名，不会将这些检查视为真机隐私或功能验收。

## 签名与可修改性

官方更新必须保持签名身份。用户自行构建修改版（包括 LGPL 库替换）可用自己的密钥经 zipalign / apksigner 签名，无需取得官方密钥。不同签名一般不能覆盖原安装，先备份并使用独立测试设备。不要为测试而卸载用户的原应用或清除资料。[LGPL 材料与重建步骤](lgpl-distribution.md)说明两个已知库的来源、校验和替换参数。

最终分发须同时保存源码快照、APK、签名证书、依赖清单及 LGPL 材料的摘要，实测首次安装、保数据覆盖、登录恢复、播放、离线、备份恢复、权限和实际网络行为。旧 Build 33 内部包不能替代本次候选。
