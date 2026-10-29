// Read-only author audit. Does not install, recolour or change package validity rules.
const fs = require("node:fs");
const path = require("node:path");
const {
  loadThemeCore,
  loadSharp,
  createNodeImageDecoder,
} = require("./lib/theme-package-node.cjs");
const { auditTokenGroup } = require("./lib/theme-token-contrast.cjs");

function invalidHost(message) {
  throw Object.assign(new Error(`Invalid host configuration: ${message}`), {
    code: "HOST_CONFIG_INVALID",
  });
}

function validateHost(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidHost("expected a JSON object");
  // Matches core/theme-package.ts version()/text() (lines 47–97 on this base).
  // That parser is private; keep its 80-char SemVer/safe-number contract here,
  // without applying manifest capability-list bounds to the host's string[].
  const version = value.appVersion;
  const match =
    typeof version === "string" && version.length <= 80 && version === version.trim()
      ? /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
          version,
        )
      : null;
  if (
    !match ||
    match.slice(1, 4).some((number) => !Number.isSafeInteger(Number(number))) ||
    (match[4]?.split(".") || []).some(
      (part) => /^[0-9]+$/.test(part) && part.length > 1 && part.startsWith("0"),
    )
  )
    invalidHost("appVersion must satisfy the core's safe SemVer contract");
  if (
    !Array.isArray(value.capabilities) ||
    value.capabilities.some((entry) => typeof entry !== "string")
  )
    invalidHost("capabilities must be a string array");
  return { appVersion: version, capabilities: [...value.capabilities] };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "Usage: node scripts/theme-contrast.cjs <archive.melotheme> [host.json]\nRead-only solid-token report; exit 0 means only the audited pairs meet 4.5:1, not whole-theme accessibility. Exit 2: valid package with low contrast; 1: invalid package; 3: usage/execution error.\n",
    );
    return;
  }
  if (!args.length || args.length > 2 || args[0].startsWith("--"))
    throw new Error("Usage: node scripts/theme-contrast.cjs <archive.melotheme> [host.json]");
  const core = loadThemeCore(),
    sharp = loadSharp(),
    root = path.resolve(__dirname, ".."),
    host = validateHost(
      JSON.parse(
        fs.readFileSync(
          path.resolve(args[1] || path.join(root, "theme-packages/reference-host.json")),
          "utf8",
        ),
      ),
    );
  let verified;
  try {
    const input = path.resolve(args[0]),
      stat = fs.statSync(input);
    if (!stat.isFile()) throw new Error("Archive input must be a file");
    if (stat.size > core.themePackageLimits.archiveBytes)
      throw new core.ThemePackageError("LIMIT_EXCEEDED", "Archive size exceeds the design ceiling");
    verified = await core.validateThemePackage(
      new Uint8Array(fs.readFileSync(input)),
      host,
      createNodeImageDecoder(sharp),
    );
  } catch (error) {
    if (!(error instanceof core.ThemePackageError)) throw error;
    process.stderr.write(
      JSON.stringify({ status: "invalid-package", code: error.code, message: error.message }) +
        "\n",
    );
    process.exitCode = 1;
    return;
  }

  const tokenDocument = JSON.parse(
    core.utf8(verified.files.find((file) => file.path === "tokens.json").bytes),
  );
  const modes = {
    light: { status: "audited", pairs: auditTokenGroup(verified.snapshot.tokens.light) },
    dark: verified.snapshot.tokens.dark
      ? { status: "audited", pairs: auditTokenGroup(verified.snapshot.tokens.dark) }
      : {
          status: "unassessed",
          reason: tokenDocument.dark === undefined ? "absent" : "unsupported-by-target-host",
        },
  };
  const rows = [modes.light, modes.dark].flatMap((mode) => mode.pairs || []),
    normalTextFailures = rows.filter((row) => !row.normalText).length,
    largeTextFailures = rows.filter((row) => !row.largeText).length;
  process.stdout.write(
    JSON.stringify(
      {
        status: "valid-package-contrast-report",
        package: verified.snapshot.package,
        targetHost: { appVersion: host.appVersion, capabilities: [...host.capabilities] },
        scope: "solid-semantic-token-pairs-only",
        targets: { normalText: 4.5, largeText: 3 },
        modes,
        summary: { auditedPairCount: rows.length, normalTextFailures, largeTextFailures },
        notAssessed: [
          "Actual font size/weight and eligibility for the large-text threshold",
          "Images, PNG icons, gradients, alpha/pressed/disabled states and composited backgrounds",
          "Rendered pages, layout, screen readers and whole-theme accessibility",
        ],
        warnings: verified.snapshot.warnings,
        decoder: `sharp ${sharp.versions.sharp}`,
        installed: false,
      },
      null,
      2,
    ) + "\n",
  );
  process.exitCode = normalTextFailures ? 2 : 0;
}

main().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      status: "execution-error",
      code: error.code || "AUTHOR_AUDIT_ERROR",
      message: error.message,
    }) + "\n",
  );
  process.exitCode = 3;
});
