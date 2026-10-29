// Author-side solid-colour audit only; never an installation or renderer gate.
// Same sRGB linearisation as WidgetThemeProjection.playIconColor, extended to two colours.
function linear(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
function luminance(hex) {
  if (typeof hex !== "string" || !/^#[0-9a-f]{6}$/i.test(hex))
    throw new TypeError("Contrast colours must be six-digit HEX");
  return (
    0.2126 * linear(Number.parseInt(hex.slice(1, 3), 16)) +
    0.7152 * linear(Number.parseInt(hex.slice(3, 5), 16)) +
    0.0722 * linear(Number.parseInt(hex.slice(5, 7), 16))
  );
}

function contrastRatio(foreground, background) {
  const a = luminance(foreground),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// These are existing solid-token uses, not an exhaustive map of rendered pixels.
const pairs = [
  ["body-on-page", "text.primary", "surface.base"],
  ["muted-on-page", "text.secondary", "surface.base"],
  ["body-on-card", "text.primary", "surface.card"],
  ["muted-on-card", "text.secondary", "surface.card"],
  ["primary-button", "text.inverse", "action.primary"],
  ["secondary-button", "action.primary", "surface.tinted"],
  ["selected-navigation", "action.primary", "surface.base"],
  ["error-on-card", "state.error", "surface.card"],
];

function auditTokenGroup(tokens) {
  const color = (path) => {
    const [group, name] = path.split(".");
    return tokens[group][name];
  };
  return pairs.map(([usage, foregroundToken, backgroundToken]) => {
    const foreground = color(foregroundToken),
      background = color(backgroundToken),
      ratio = contrastRatio(foreground, background);
    return {
      usage,
      foregroundToken,
      backgroundToken,
      foreground,
      background,
      ratio,
      // Compare unrounded ratios; output keeps the full JS number too.
      normalText: ratio >= 4.5,
      largeText: ratio >= 3,
    };
  });
}

module.exports = { contrastRatio, auditTokenGroup };
