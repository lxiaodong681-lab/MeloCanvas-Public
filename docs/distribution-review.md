# 发行材料审核状态

发行版本：**0.19.4 Build 35**；更新：2026-10-29。本文记录材料与检查边界；最终结论以同一发行条目随包提供的依赖、签名和验证报告为准，不以版本号或旧 CI 结果代替。

## 本轮已补齐

- **8 个 npm 缺失文本**：React Native 0.86.3 的 assets-registry、js-polyfills、normalize-colors、virtualized-lists，Metro runtime 0.84.5，Nitro Fetch 1.7.0，Nitro Modules 0.37.1，boolbase 1.0.0。前七项以 npm 发布 gitHead 对照上游许可 blob；boolbase 的已发布 index.js 与补入 ISC 许可的固定历史提交完全一致。证据见 [版本及文件摘要清单](../release/dependency-licenses.json)。
- 从实际 Release Metro 附件保存已有许可，再加入原生源码模块声明。清单登记 **74 个 npm / 原生源码包、4 个 workspace 包、16 个 Gradle 源码模块、175 个 Maven 坐标**；这是已审版本集合，最终打包数量由 CI 实测，允许减少，新增或变更必须重新审查。
- 核查 **152 份 Maven 官方源码附件**，保留内嵌 LICENSE / NOTICE 及源码版权注释。React Native、Hermes 未发布同名 Maven sources 附件，改用固定版本上游材料；Guava 的空冲突规避占位 JAR 单独记录。POM 原始声明、源码附件摘要及二进制摘要均保留，不将 POM 标签作为唯一依据。
- 补入 React Native 的 Boost / double-conversion / fast_float / fmt / Folly / glog、Hermes 内嵌声明、Fresco 的 GIF / JPEG / PNG / WebP、libavif / dav1d / libyuv、MMKV 聚合声明、zstd、NDK / libc++ 等材料。Cronet 对应版本完整聚合文本继续保留。NDK 与部分上游聚合声明范围较宽，包含可选或主机工具说明，不表示这些工具都进入 APK。
- 补入 Expo 完整第三方聚合声明、Kotlin 的 COPYRIGHT / NOTICE 及 JVM 标准库额外许可、协程 NOTICE。MMKV annotation:2.4.0 的 POM 标为 BSD，但其实际 FastNative 源码头为 AOSP Apache-2.0；按源码保留 Apache 文本和版权，同时保留上游聚合声明。
- 离线许可页直接从已校验文本生成，按条目展开全文，并嵌入文件摘要。项目代码 MIT 与 OC 专用许可分别显示。

## 条款处理

| 类型 | 本项目分发处理 |
| --- | --- |
| MIT / ISC / BSD / Boost | 保留原作者版权、许可、免责声明；BSD 不提供上游背书。不能以项目 MIT 覆盖第三方或 OC 条款。 |
| Apache-2.0 | 保留全文、已发现的 NOTICE 与源码版权；本地改编在来源记录中说明。不得将原商标用作项目背书。 |
| 多选许可证 | JSZip 与 fast_float 选择 MIT；node-forge 与 zstd 选择 BSD。原始文件可同时描述其他选项，不代表本应用选择了 GPL。 |
| 图像解码与专利文本 | 保留 libwebp / dav1d / libyuv 的适用专利授权与上游声明，并明确致谢 Independent JPEG Group；不将这些文件解释为对所有第三方内容或所有专利的保证。 |
| LGPL-2.1 / LGPL-2.1-or-later | SuperLyricApi 2.4、jaudiotagger 3.0.1 的对应源码、构建说明、替换脚本和修改验证材料须与接收者同时提供。允许为修改这些库进行必要的调试和重新链接；不要求开发者签名密钥。详见 [LGPL 分发说明](lgpl-distribution.md)。 |
| MPL-2.0 | OkHttp 的 Public Suffix List 保留完整 MPL 和原始可编辑名单；已逐字节验证该源码可还原实际 JAR 的表数据，APK 检查继续核验。源码随完整快照免费提供，见 [名单源码与说明](../licenses/source/publicsuffix/README.md)，不受项目 MIT 或 OC 条款替代。 |

### Install Referrer

已核对 [Android SDK 条款](https://developer.android.com/studio/terms) 的 3.1、3.4、3.5、3.8，以及该组件 POM。它声明的是 Android SDK 许可，不能改标 Apache-2.0。产品只通过 expo-application 读取版本号，现改用 APK 内嵌 Expo 配置，并将该未使用模块从原生自动链接排除。CI 同时检查实际 Metro / Gradle 清单及 APK DEX 中不存在该模块和 Install Referrer；**只有实际构建检查通过，才算关闭本候选的该项分发问题**。这不是对独立分发该 SDK 的授权意见。

## 复制代码来源

[逐文件记录](../release/vendored-sources.json) 区分原样文件与修改：Callstack bottom-tabs 1.4.0 固定 npm gitHead 下 41 个文件一致、20 个已修改、1 个为本地文件；固定上游树未发现 NOTICE。Lyricon 的 model 目录与固定上游版本完全一致，版权头及 Apache-2.0 原文保留，该树未发现 NOTICE。Netease 三个文件为 TypeScript 移植，直接来源固定到 BBPlayer；保留 Binaryify MIT 和文件头，不声称与原始 JavaScript 逐字一致。改编和格式变化不是重新授权。

## 最终包检查及剩余边界

`verify-distribution-licenses.cjs --actual` 对实际 Metro 包版本 / 声明摘要、Maven 二进制摘要、原生源码模块及已排除 SDK 作失败关闭检查；缺文本、空清单、未解析来源或新依赖均不能通过。APK 校验还要求正确版本 / 包名、ARM64、非调试 Release、Hermes、ZIP 校验和对齐，以及预期签名证书。

LGPL 两库已有 Linux 源码重建、替换依赖与 DEX 验证；每个最终提交继续重跑。验证用修改库 APK 与用户验收 APK 分开保存，前者不作为验收安装包。最新证明留在同一提交的 CI 附件及交付清单，旧证明不自动继承到新包。

完整源码快照、第三方声明、LGPL 对应源码和重建材料必须与 APK 同时交付，并保存最终签名包、源码和材料的摘要绑定；私有 PR 链接或会过期的 CI 附件不能代替公开分发材料。维护者已确认采用独立的 MeloCanvas-Public 公开库，原有开发库保持私有。真机反馈与未验证范围见 [版本说明](public-beta-status.md)，自动化构建和静态权限核验不等于所有设备的运行期隐私验收。
