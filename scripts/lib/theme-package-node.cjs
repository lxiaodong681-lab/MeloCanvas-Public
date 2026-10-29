// Author/test adapter only. Never imported by the browser/RN validation core.
const path = require("node:path");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../..");
const mobileRequire = createRequire(path.join(root, "android-app/apps/mobile/package.json"));
function loadSharp() {
  try {
    const expoRequire = createRequire(mobileRequire.resolve('expo/package.json'));
    const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
    const imageRequire = createRequire(cliRequire.resolve('@expo/image-utils/package.json'));
    const candidate = process.env.MELO_THEME_SHARP || imageRequire.resolve('sharp');
    return require(candidate);
  } catch (cause) {
    throw new Error(
      "A working sharp decoder is required. Set MELO_THEME_SHARP to the installed module path; no header-only fallback is permitted.",
      { cause },
    );
  }
}
function loadThemeCore() {
  mobileRequire("tsx/cjs");
  return {
    ...require("../../android-app/apps/mobile/melo/core/theme-package.ts"),
    ...require("../../android-app/apps/mobile/melo/core/theme-archive.ts"),
    ...require("../../android-app/apps/mobile/melo/core/theme-package-types.ts"),
  };
}
function createNodeImageDecoder(sharp = loadSharp()) {
  return {
    async decodeImage(bytes, limits, signal) {
      if (signal?.aborted) throw new Error("Image decode cancelled");
      // These limits are supplied BEFORE metadata or pixel decoding. Normalized
      // output is uchar RGBA; core preflight rejects >8-bit and animated PNG.
      const pixels = Math.min(limits.imagePixels, Math.floor(limits.decodedImageBytes / 4));
      const image = sharp(bytes, {
        limitInputPixels: pixels,
        sequentialRead: true,
        failOn: "warning",
        animated: false,
      }).timeout({ seconds: 5 });
      let rejectCancelled;
      const cancelled = new Promise((resolve, reject) => {
        rejectCancelled = reject;
      });
      const abort = () => {
        rejectCancelled(new Error("Image decode cancelled"));
        image.destroy();
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        return await Promise.race([
          cancelled,
          (async () => {
            const metadata = await image.metadata();
            if (
              metadata.format !== "png" ||
              (metadata.pages || 1) !== 1 ||
              !metadata.width ||
              !metadata.height ||
              metadata.width > limits.imageDimension ||
              metadata.height > limits.imageDimension ||
              metadata.width * metadata.height > pixels
            )
              throw new Error("Image format/frame/dimension budget mismatch");
            const { data, info } = await image
              .toColourspace("srgb")
              .ensureAlpha()
              .raw({ depth: "uchar" })
              .toBuffer({ resolveWithObject: true });
            if (signal?.aborted) throw new Error("Image decode cancelled");
            if (
              info.channels !== 4 ||
              info.width !== metadata.width ||
              info.height !== metadata.height ||
              data.length !== info.width * info.height * 4 ||
              data.length > limits.decodedImageBytes
            )
              throw new Error("Decoded image exceeds its budget");
            return {
              mime: "image/png",
              width: info.width,
              height: info.height,
              frames: 1,
              decodedBytes: data.length,
            };
          })(),
        ]);
      } finally {
        signal?.removeEventListener("abort", abort);
        image.destroy();
      }
    },
  };
}
module.exports = { loadSharp, loadThemeCore, createNodeImageDecoder, mobileRequire };
