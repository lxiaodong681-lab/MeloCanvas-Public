# Android theme PNG decoder

`decodeThemeImageAsync(Uint8Array, {fileBytes,imagePixels,imageDimension,decodedImageBytes})`
returns only `{mime:'image/png',width,height,frames:1,decodedBytes}`. The Melo
adapter is `apps/mobile/melo/theme-image-decoder.ts` (`themeImageDecoder` and
`createThemeImageDecoder`). It implements the existing `ThemeImageDecoder` contract.
No file/URI/network interface or theme activation is added. Expo 57's cached
`ByteArrayTypeConverter` explicitly accepts `UINT8_TYPED_ARRAY`; no base64 is used.

Both layers enforce positive integer budgets that cannot enlarge the hard caps:
8 MiB compressed input, 8,000,000 pixels, 8192 per dimension, 32 MiB RGBA output.
JS snapshots only bounded input. Native rejects concurrent work immediately;
the JS adapter also stays busy after abort until its underlying native promise
settles. UI cancellation may hide the operation immediately; an in-flight decode
promise rejects with `CANCELLED` only after native actually settles, discarding
late success and consuming late failure. Awaiting the installer's cancellation
therefore drains the real native slot before opening the next picker/import.
An already-aborted call still rejects before invoking native.

The pure verifier checks PNG signature, chunk bounds/order/CRC, static <=8-bit
legal color combinations, palette/transparency constraints, and refuses APNG or
unknown mandatory chunks. Standard `Inflater` verifies the entire IDAT zlib stream,
Adler checksum, no compressed trailing bytes, exact scanline sizes including
Adam7, and valid filter selectors. SDK 32 device evidence showed that the system
accepts an indexed PNG whose pixel references a missing PLTE entry. For indexed
PNG only, the verifier therefore reverses filters 0–4 into two reused packed-row
buffers and checks actual 1/2/4/8-bit sample indices against PLTE length. It skips
padding bits and resets the prior row for each Adam7 pass. This check performs
neither palette-to-RGBA conversion nor color management; Android still decodes
the bitmap. Legitimate short palettes remain supported.
ICC/zTXt/compressed iTXt streams are also fully inflated with a 1 MiB per-block
and 2 MiB aggregate output cap; buffers are discarded, not accumulated. Metadata
field framing and iTXt UTF-8 are checked. ICC color semantics remain Android's job.
All validation uses one five-second monotonic deadline plus progress checks;
this deadline cannot interrupt a blocking system bitmap call.

After preflight, API 28+ uses `ImageDecoder` with software allocation, sRGB and a
partial-image listener that always refuses partial results. API 26/27 uses actual
`BitmapFactory.decodeByteArray` with ARGB_8888, no scaling and sRGB after the same
strict stream checks, avoiding acceptance based only on BitmapFactory's leniency.
Both paths require matching dimensions, ARGB_8888 and bounded bitmap allocation,
and recycle in `finally`. Min SDK stays 26. Platform color/pixel decoding is not
reimplemented; the returned byte count is normalized width * height * 4.

Verification: 19 pure JVM cases cover CRC-correct truncated/invalid deflate,
Adler/trailing data, incomplete/excess/filter-invalid scanlines, Adam7, APNG,
limits/deadline, normal/compressed international metadata and metadata bombs,
plus every indexed filter, packed depths, padding, Adam7 reset and buffer splits.
Three 9x9 fixtures were generated locally with existing Sharp 0.34.5: real sRGB
ICC plus zTXt/iTXt text, indexed PNG, and Adam7 PNG. The JVM tests verify their
container/streams, **not Android pixels**. The five Melo TS cases cover snapshots,
budgets, pre-abort, cancellation settlement after native success/failure, direct
concurrent-call rejection and admission release. Both settlement assertions fail
against the original early-rejection implementation and pass with this fix.
A real WorkshopSession + InstallSession + NodeFS/SQLite reproduction also verifies
that close clears UI immediately, retry waits for native and then previews the
valid package without changing the active pointer or reporting a busy decode as
damaged PNG. The bridge is delayed for this test; pixel decoding uses local Sharp.
Actual Android API 26/27 and 28+ pixel compatibility and memory behavior require
the root agent's device checks; no device tests were run in this worktree.
The initial SDK 32 device run exposed the missing-index defect. The root agent
repeated all 18 fixtures against the fix: valid short PLTE is accepted and the
out-of-range index is rejected. Six repeated 8MP decodes also completed. Evidence
is in `verification/increments/theme-native-decoder/device-fixed/`; this external
helper measures the decoder process, not the whole React Native app. API 26/27
device behavior and the JS/native bridge still require separate integration checks.

At this freeze: the standard Melo glob passes 185/185 (including the five new
adapter cases), `pnpm type-check` and `pnpm lint` pass. Offline
`:bbplayer-native:testDebugUnitTest :bbplayer-native:build` succeeds, with 19/19
JVM cases in each of Debug and Release. Android lint reports 0 errors / 8 warnings.
The isolated build's temporary include script and complete logs remain local in
`verification/build/theme-native*`; they are not production configuration.

The isolated worktree's baseline excluded `@bbplayer/native` from Expo autolinking,
so its package build used a temporary include script. The integration branch has
enabled autolinking and explicitly blocks the existing package-install permission;
the final merged manifest and JS bridge remain root-owned build/device checks.
The decoder changes do not remove existing native features or change dependencies,
the Expo registration file, or the app version.
