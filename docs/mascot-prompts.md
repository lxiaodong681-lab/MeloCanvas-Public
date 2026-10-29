# 看板娘素材整理提示词

日期：2026-10-28。方式：内置 imagegen；每个动作一次独立编辑调用，transparent_background=true。唯一参考是维护者提供的八态贴纸拼图；原稿与私人生成文件路径不写入公开源码。整张排版的试稿未采用。最终独立 PNG 保留生成器 alpha，没有二次算法抠图。

以下公共提示中的 `{pose}` 替换为对应动作文本，构成各图片的完整提示。提示中的留白比例为生成目标，交付尺寸与实际边缘仍需检查。

OC 立绘、表情及透明衍生图采用专用素材许可，见 [素材说明](mascot-assets.md)，不因使用本提示词或编辑工具而改为 MIT。

## portrait-cutout.png

单独使用维护者的白底立绘作为编辑目标，内置 imagegen，transparent_background=true；保留原稿，另存透明版本。完整提示词：

```text
Edit target: the supplied full-body original MeloCanvas OC portrait. Remove ONLY the white background to true transparent alpha. Preserve the exact character, face, expression, pose, hairstyle, fine hair strands, white-to-blue hair gradients, cat ears, large tail, white-and-blue dress, navy ribbons, flowers, jewelry, hand and feet positions, proportions, original framing and colors. This is a faithful background-removal cutout, NOT a redesign or restyling. Keep ALL white fur, white hair, white fabric and small enclosed character details opaque; remove background also between strands, arms, dress ribbons and legs. Clean antialiased edges without a white matte, glow, border, black fringe or shadow, suitable on both dark and light app backgrounds. Preserve the complete head, ears, floating ornaments, tail and shoes. No new objects, text, watermark or backdrop. Transparent background PNG, same portrait aspect ratio as the reference.
```

## 八态公共提示

```text
Use case: background-extraction and precise-object-edit. Create ONE standalone polished transparent PNG sticker from the supplied sheet for the MeloCanvas app. Target ONLY {pose} Remove the other seven figures entirely. Re-render minor edges as necessary to eliminate ragged cyan halos, specks, white cutout noise, and stray pixels. Keep this original catgirl identity: white hair fading light blue, cat ears, blue-white flower on her RIGHT temple (viewer's left) unless hidden naturally by pose, dark navy ribbons, small blue jewel, blue-white dress, big fluffy white tail with blue shades. Same adorable round-faced tiny-limbed chibi proportions and gentle detailed anime rendering as reference. No new design or outfit. Show exactly the described original pose and original props only. Complete figure centered within a square canvas, entire silhouette and every prop contained within central 78% width and 78% height, at least 11% transparent padding on all sides. True clean alpha transparency, fine smooth antialiased edge with a consistent thin navy outline, no sticker border, no backdrop, no scene, no labels, no watermark, no grid, no other characters. This is one character, not a sheet. Prioritize clean edges over preserving noise from the input.
```

## playing.png

```text
TOP LEFT: closed eyes and open happy smile, wearing headphones and enjoying music, both small hands raised, tiny blue music notes.
```

## video.png

```text
TOP ROW SECOND: wide blue eyes, holding a small blue rounded screen with a white triangular play symbol, quietly watching/listening.
```

## loading.png

```text
TOP ROW THIRD: cheeks puffed with effort, pushing a black vinyl record with a white-blue circular label.
```

## empty.png

```text
TOP RIGHT: curious blue eyes, both paws resting on an empty open blue record storage box with a circular record symbol.
```

## search.png

```text
BOTTOM LEFT: lying prone and peering through a large magnifying glass, fluffy tail curling behind.
```

## error.png

```text
BOTTOM ROW SECOND: seated confused, holding two disconnected blue audio cable plugs, no tears or extra symbols.
```

## liked.png

```text
BOTTOM ROW THIRD: eyes closed smiling, hugging a large blue heart, with one small gold sparkle.
```

## sleep.png

```text
BOTTOM RIGHT: sleeping curled on her fluffy tail, blue headphones, a small crescent moon.
```
