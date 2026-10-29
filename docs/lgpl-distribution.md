# LGPL 对应源码与重新构建

适用版本：0.19.4 Build 35。对应源码、重建说明和替换工具随完整源码与 LGPL 材料包分发。两库重建、依赖替换及 DEX 验证必须绑定同一发行源码，具体证明见该版本的发行附件；旧构建结果不能替代当前包验证。[依赖审核状态](distribution-review.md) 记录材料范围及检查边界。

## 固定来源

- `com.github.HChenX:SuperLyricApi:2.4`：LGPL-2.1；[上游提交](https://github.com/HChenX/SuperLyricApi/tree/092adf531c8840549dd872aa795820b0161f86bb)。归档保留该版本全部 24 个文件，包括 Java、AIDL、Gradle 配置、wrapper、README 和 LICENSE；逐文件 Git blob / SHA-256 已核对。不含项目自行修改的库源码。
- `net.jthink:jaudiotagger:3.0.1`：LGPL-2.1-or-later；[Maven Central 源码包](https://repo.maven.apache.org/maven2/net/jthink/jaudiotagger/3.0.1/jaudiotagger-3.0.1-sources.jar)及同版本 POM。POM 与源码头明确允许 2.1 或后续版本；源码包含 551 个 Java 文件及资源。POM 中的历史 SCM 标签目前无法读取，因此保留实际分发源码包作为依据，不将不可取得的标签称为已核实。

归档摘要见 [材料清单](../release/lgpl-materials.json)。完整 [LGPL-2.1](../licenses/LGPL-2.1.txt) 随源码及应用内“开源许可”页提供。MeloCanvas 自有代码采用 [MIT](../LICENSE)，不会限制用户修改库、重新链接或为调试修改而进行逆向工程。

## 使用源码材料

在最终 APK 的同一下载位置提供对应的 MeloCanvas 完整源码快照和 `MeloCanvas-0.19.4-Build35-LGPL-sources.zip`，同时提供各自 SHA-256。不能只放上游链接、只附许可证或让接收者申请私有开发库访问。源包必须与实际构建匹配；当前清单不是所有 APK 依赖的完整许可证清单。

SuperLyricApi：在源码目录使用 JDK 21、Android SDK 35，运行 `./gradlew :api:assembleRelease`（Windows 使用 `gradlew.bat`）。原项目固定 AGP 8.13.0，生成 `api/build/outputs/aar/api-release.aar`。源码未修改；如自行修改，保留原许可并记录修改。

Jaudiotagger：将 `jaudiotagger-3.0.1-sources.jar` 解包到新目录的 `src/`，将同版本 POM 保存为根目录 `pom.xml`。使用 JDK 8 或兼容工具链运行 `mvn -DskipTests package`；POM 的 source/target 为 1.8。生成 `target/jaudiotagger-3.0.1.jar`。保留包内资源、原作者及其第三方文件头。材料包还附有不依赖 Maven 的 `build-jaudiotagger.ps1`，用于本地编译校验。

在 MeloCanvas 快照中按 [构建指南](android-build.md) 安装冻结依赖，进入 `android-app/apps/mobile/android`，将下面的示例绝对路径改为自己的输出：

```sh
bash ./gradlew :app:assembleRelease \
  -PmeloUnsignedRelease=true -PreactNativeArchitectures=arm64-v8a \
  --init-script ../../../../scripts/android-ci.init.gradle \
  --init-script ../../../../scripts/lgpl-relink.init.gradle \
  -PmeloSuperLyricAar=/absolute/path/api-release.aar \
  -PmeloJaudiotaggerJar=/absolute/path/jaudiotagger-3.0.1.jar
```

两个替换参数均可独立使用；缺少文件或坐标不符会失败，不会静默用原库代替。本地 AAR 不含 Maven 传递信息，脚本保留 SuperLyricApi 2.4 的 annotation 1.9.1 依赖。最终发行前需记录替换构建的实际产物、DEX / 类内容、安装及播放结果，不能用脚本文本代替执行证据。

## 自动重建与替换验证

`scripts/verify-lgpl-relink.cjs` 在 Linux PR CI 使用 JDK 21 编译 SuperLyricApi、JDK 17 / Java 8 target 编译 jaudiotagger。它按 [24 文件摘要表](../release/superlyric-source-files.json) 核对 SuperLyricApi 固定提交，并按材料清单核对 Maven Central 源码 JAR 与 POM；源码缺失、数量或摘要不符即失败。

验证副本各增加一个独立 Java 类，并保留日期、LGPL 与修改说明。随后使用公开的替换脚本构建未签名 APK，要求两个本地文件的摘要出现在解析清单中、原 Maven 坐标消失、两个验证类均进入 DEX。普通候选 APK 在此之前已单独保存，验证副本不签名、不安装、不发布，也不会被当作正式候选。私有 CI 的 `lgpl-relink-verification` 附件保留重建源包、摘要和结果；只有实际成功结果才能关闭“可重新链接”的构建验证项，运行期验收另行完成。

输出为未签名 APK。使用 Android SDK 的 `zipalign`、`apksigner` 及自己生成的密钥即可签名；无需开发者私钥。自签名包通常不能覆盖官方签名安装，应在独立测试设备安装；更换签名或卸载会影响已有数据，先导出备份。分发原始正式版本才需要保持官方更新签名身份，这不限制用户构建自己的修改版。

2026-10-28 的实际执行证据见 [重建结果](../release/lgpl-relink-evidence.json)。两库源码校验与编译、原坐标替换、本地文件摘要、两枚验证类进入 DEX 均通过；已下载并核对私有 CI 材料包。证据绑定 `e1ba8e29`，验证 APK 摘要为 `1e8304c1f70442fe726d8b104eb6a451791777c7cff8b3eaa0b4ecb17de9237b`。这是带验证类的未签名副本，不能作为候选安装包；后续提交仍需重新验证。

## 最终分发仍需完成

CI 通过 `release-dependencies.init.gradle` 记录实际 Release runtime 外部二进制及本地 JAR/AAR 的坐标与 SHA-256（无机器路径），另列源码构建模块的 `localProjects`。Android 模块的 classes、assets、JNI、metadata 等产物变体不混作独立 Maven 依赖；其传递二进制仍保留。源码模块需结合对应源码和最终 APK 检查，不能把该清单称为全部打包文件清单。据此核对 JitPack 二进制、Maven JAR、传递依赖和 npm / 原生代码的版权、NOTICE 与源码义务，再与最终 APK 摘要绑定。当前未将“两个已知 LGPL 库材料已准备”视为完整 APK 合规放行。
