// Author API 0.x. This produces/validates a formal ZIP, never installs/applies it.
const fs = require("node:fs");
const path = require("node:path");
const {
  loadSharp,
  loadThemeCore,
  createNodeImageDecoder,
  mobileRequire,
} = require("./lib/theme-package-node.cjs");

async function main() {
  const [command, input, output, hostFile] = process.argv.slice(2);
  if (!["build", "validate"].includes(command) || !input || (command === "build" && !output)) {
    console.log(
      "Usage:\n  node scripts/theme-package.cjs build <source-directory> <output.melotheme> [host.json]\n  node scripts/theme-package.cjs validate <archive.melotheme> [host.json]\nMELO_THEME_SHARP may specify a working sharp module. Host defaults to theme-packages/reference-host.json (author reference target, not proof of an installed RN renderer).",
    );
    if (command !== "--help") process.exitCode = 1;
    return;
  }
  const core = loadThemeCore(),
    sharp = loadSharp(),
    decoder = createNodeImageDecoder(sharp),
    JSZip = mobileRequire("jszip");
  const root = path.resolve(__dirname, "..");
  const hostPath = command === "validate" ? output : hostFile;
  const host = JSON.parse(
    fs.readFileSync(
      path.resolve(hostPath || path.join(root, "theme-packages/reference-host.json")),
      "utf8",
    ),
  );
  let archive;
  if (command === "build") {
    const sourceRoot = fs.realpathSync(path.resolve(input));
    function sourceFile(relative) {
      core.safePackagePath(relative);
      let target = sourceRoot;
      for (const part of relative.split("/")) {
        target = path.join(target, part);
        if (fs.lstatSync(target).isSymbolicLink())
          throw new Error("Author source links are not accepted");
      }
      const real = fs.realpathSync(target),
        stat = fs.statSync(real);
      if (
        !real.startsWith(sourceRoot + path.sep) ||
        !stat.isFile() ||
        stat.size > core.themePackageLimits.fileBytes
      )
        throw new Error("Author source escapes directory or exceeds file budget");
      return fs.readFileSync(real);
    }
    const source = JSON.parse(sourceFile("source.json").toString("utf8"));
    if (
      !source.manifest ||
      !source.images ||
      Array.isArray(source.images) ||
      Object.keys(source.images).length > core.themePackageLimits.assets
    )
      throw new Error("Expected author source manifest/images map");
    const files = new Map();
    for (const name of ["tokens.json", "components.json", "LICENSE.txt"])
      files.set(name, sourceFile(name));
    let generatedBytes = [...files.values()].reduce((total, bytes) => total + bytes.length, 0);
    const assets = [];
    for (const [destination, relative] of Object.entries(source.images).sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      core.safePackagePath(destination);
      const inputBytes = sourceFile(relative);
      const png = [137, 80, 78, 71, 13, 10, 26, 10].every(
        (byte, index) => inputBytes[index] === byte,
      );
      if (
        !png &&
        (!relative.endsWith(".svg") ||
          !/^\s*(?:<\?xml[^>]*\?>\s*)?<svg\b/i.test(inputBytes.toString("utf8")) ||
          /<!DOCTYPE|<!ENTITY|<script|<foreignObject|<image|<use|href\s*=|url\s*\(/i.test(
            inputBytes.toString("utf8"),
          ))
      )
        throw new Error(
          "Author input must be PNG or local geometry-only SVG; no disguised files, scripts or references",
        );
      const image = sharp(inputBytes, {
        limitInputPixels: core.themePackageLimits.imagePixels,
        failOn: "warning",
        animated: false,
      }).timeout({ seconds: 5 });
      const metadata = await image.metadata();
      if (
        !["png", "svg"].includes(metadata.format) ||
        (metadata.pages || 1) !== 1 ||
        !metadata.width ||
        !metadata.height ||
        metadata.width > core.themePackageLimits.imageDimension ||
        metadata.height > core.themePackageLimits.imageDimension ||
        metadata.width * metadata.height > core.themePackageLimits.imagePixels
      )
        throw new Error("Author image format/frames/pixels exceed supported subset");
      const bytes = await image
        .toColourspace("srgb")
        .ensureAlpha()
        .png({ compressionLevel: 9, bitdepth: 8 })
        .toBuffer();
      generatedBytes += bytes.length;
      if (
        bytes.length > core.themePackageLimits.fileBytes ||
        generatedBytes > core.themePackageLimits.totalBytes
      )
        throw new Error("Generated author images exceed the package byte budget");
      if (files.has(destination)) throw new Error("Duplicate author output");
      files.set(destination, bytes);
      assets.push({
        path: destination,
        mime: "image/png",
        bytes: bytes.length,
        sha256: core.sha256(bytes),
      });
    }
    const manifest = { ...source.manifest, assets };
    files.set("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
    const zip = new JSZip();
    for (const [name, bytes] of [...files].sort((a, b) => a[0].localeCompare(b[0])))
      zip.file(name, bytes, {
        createFolders: false,
        date: new Date("2000-01-01T00:00:00Z"),
        unixPermissions: 0o100644,
      });
    archive = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
      platform: "UNIX",
    });
    const verified = await core.validateThemePackage(archive, host, decoder);
    const target = path.resolve(output),
      temporary = `${target}.tmp-${process.pid}`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.writeFileSync(temporary, archive);
      fs.renameSync(temporary, target);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    console.log(
      JSON.stringify(
        {
          status: "validated-reference-package",
          output: target,
          id: verified.manifest.id,
          archiveSha256: verified.snapshot.package.archiveSha256,
          bytes: archive.length,
          decoder: `sharp ${sharp.versions.sharp}`,
          warnings: verified.snapshot.warnings,
          installed: false,
        },
        null,
        2,
      ),
    );
  } else {
    const stat = fs.statSync(path.resolve(input));
    if (!stat.isFile() || stat.size > core.themePackageLimits.archiveBytes)
      throw new Error("Archive size exceeds the design ceiling");
    archive = new Uint8Array(fs.readFileSync(path.resolve(input)));
    const verified = await core.validateThemePackage(archive, host, decoder);
    console.log(
      JSON.stringify(
        {
          status: "validated-reference-package",
          id: verified.manifest.id,
          archiveSha256: verified.snapshot.package.archiveSha256,
          files: verified.files.map((file) => ({
            path: file.path,
            bytes: file.bytes.length,
            sha256: file.sha256,
            image: file.image,
          })),
          warnings: verified.snapshot.warnings,
          decoder: `sharp ${sharp.versions.sharp}`,
          installed: false,
        },
        null,
        2,
      ),
    );
  }
}
main().catch((error) => {
  console.error(`${error.code || "AUTHOR_TOOL_ERROR"}: ${error.message}`);
  process.exitCode = 1;
});
