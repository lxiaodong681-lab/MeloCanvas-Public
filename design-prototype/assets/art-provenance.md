# 原创封面资产记录

- 文件：`coast.png`
- 用途：音绘设计原型「海风来信」模拟音乐封面。
- 日期：2026-10-17（Asia/Shanghai）。
- 来源：OpenAI 内置 `image_gen` 工具原创生成；无输入图片、无外部摄影或第三方角色素材；未使用 CLI。
- 原始输出保存在作者私有生成记录中；公开仓库不记录个人电脑用户名及绝对路径。
- 检查：正方形暮色海岸，珊瑚色天空、蓝灰海水、远处微小帆船、胶片质感；无文字、UI、水印或拼贴。AI 生成场景并非真实音乐发行物或实景摄影证明。

## 精确生成提示词

```text
Use case: photorealistic-natural
Asset type: original square music album artwork for MeloCanvas, the fictional collection Sea Breeze Letters (海风来信).
Primary request: A twilight coastline with a warm coral sky, blue-gray sea, and an extremely small sailboat far away on the horizon.
Style/medium: sophisticated independent music record cover, fine-art analog photography, believable natural ocean textures, subtle fine film grain.
Composition/framing: square 1:1 image, spacious calm horizon and gently rippling water, restrained and emotionally evocative coastal composition.
Lighting/mood: soft twilight, quiet, wistful, airy.
Color palette: warm coral and peach dusk sky against slate blue-gray water.
Constraints: one coherent original photographic scene; no text, no lettering, no UI, no borders, no logos, no watermark, no collage, no recognizable copyrighted character or artwork.
```


## 听视频新增封面

2026-10-17 新增 listen-city.svg、listen-harbor.svg、listen-mountain.svg、listen-game.svg、listen-night.svg。由本项目 generate-listen-art.cjs 以原创几何构图生成，用于模拟 UP 主提供的横向封面。文字、节目名与 UP 主均为演示设定，没有下载真实视频封面、引入动漫 IP 或外部图片素材。实际产品优先显示来源视频封面，音乐专辑图仅在明确关联且具有合适使用权限时采用。

## 本次公开准备核验（2026-10-28）

维护者明确授权 MeloCanvas 自有代码与明确标注 MIT 的原创素材使用根目录 MIT。OC 立绘与八态贴纸采用下述专用素材许可，不适用 MIT。第三方内容保持原许可，既有 Paper Signal CC0 授权继续有效；这不授予外部平台内容或商标的传播权。

- 移动端 `meadow.png`、`orbit.png`：从相邻原创 SVG 用锁定安装的 sharp 0.35.4 按原尺寸栅格化，与现存 PNG **字节完全相同**，尺寸为 600×600。旧 `icon.svg` 同为项目原创几何源稿；当前 `icon.png` 已换为维护者另行提供的新图标，来源见下方品牌素材记录。
- `cosmos.png`：从私有开发记录恢复原始几何绘制程序为 `generate-cosmos.py`；仅生成背景、35 个固定随机种子的星点及圆环，没有外部图片。公开源码不包含原日志、个人路径或其他会话内容。
- `coast.png`：移动端与本目录副本摘要相同；原无参考图 AI 生成记录和提示词见上文。AI 场景不代表真实唱片或第三方平台授权。
- Android 图标由 app.config.ts 指定自有 icon.png / icon-foreground.png，实际启动图由 withMeloSplash 复制。`scripts/prepare-brand-assets.cjs` 已从新图标重新生成 launcher 和五组 splashscreen_logo 密度资源，摘要与来源已更新；最终显示仍需签名 APK 真机核验。
- starter / cosmos / progress 官方样例只使用上述图片与项目几何源稿，现随归档附完整 MIT 正文。通用用户导出流程不因此将用户图片重新授权。

各文件摘要、证据状态及未完成项见 [资产清单](../../release/asset-audit.json)。作者支持二维码是维护者有意提供的公开支持资料，支付平台标志仍保留各自权利，不能用项目 MIT 替其授权。

## 旧上游素材替换（2026-10-28）

`scripts/prepare-public-assets.cjs` 从维护者 MIT 图标生成 10 个旧启动 / 图标路径的替代文件；默认头像和通知图标来自新增的 `fallback-avatar.svg`、`notification-note.svg` 原创几何。三个 Lottie 文件改为独立编写的三角形 / 矩形图形，保留旧控制器的播放 / 暂停端点。三个 PNG 解码夹具改为合成 9×9 像素，保留 palette、Adam7、ICC、zTXt 和 iTXt 覆盖；嵌入的 sharp compact sRGB 配置版权字段为 CC0。项目生成代码 / 几何采用 MIT。

18 个替代文件均可通过 `node scripts/prepare-public-assets.cjs --check` 与已提交字节核对。旧上游的两张收款码从公开集合排除，旧支持弹窗改为提示自行核实上游官方支持方式。上述处理不为已撤下的第三方原图补授许可，也不改变音绘 OC 的专用许可。

## 看板娘与新图标（2026-10-28）

维护者提供暂定 OC 立绘、新音绘图标及八态贴纸，并选择允许整理透明边缘和轻微画面变化。原立绘和图标保留原字节；八个表情分别使用内置 imagegen 整理，另按要求生成透明立绘用于开屏。OC 采用专用素材许可，仅允许随音绘使用和分发，其他用途须经维护者许可；图标继续 MIT。来源、授权、实际使用位置和提示词见 [看板娘素材说明](../../docs/mascot-assets.md)，逐文件摘要见 [品牌素材清单](../../release/brand-assets.json)。
