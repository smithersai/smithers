import { hexAlpha, rgbChannels } from "./rgbChannels.ts";

/** Parsed 0-255 srgb channels. */
export type Rgb = readonly [number, number, number];

/**
 * Channels a color can actually have: three finite numbers from 0 to 255.
 *
 * Unrounded values are legal, because `mixChannels` returns the exact mix a
 * browser computes rather than the rounded hex. Everything else is a caller
 * mistake: `[NaN, 0, 0]` used to score `NaN`, `[Infinity, 0, 0]` scored
 * `Infinity`, and `[-255, 0, 0]` on white scored 31.3013, outside the range
 * this function documents.
 */
function checkedChannels(channels: Rgb, role: string): Rgb {
  const valid = Array.isArray(channels) && channels.length === 3
    && Number.isFinite(channels[0]) && channels[0] >= 0 && channels[0] <= 255
    && Number.isFinite(channels[1]) && channels[1] >= 0 && channels[1] <= 255
    && Number.isFinite(channels[2]) && channels[2] >= 0 && channels[2] <= 255;
  if (!valid) {
    throw new TypeError(
      `contrastRatioOf needs three finite 0-255 ${role} channels, received ${JSON.stringify(channels)}`,
    );
  }
  return channels;
}

/** WCAG 2.x relative luminance of already-parsed 0-255 channels. */
function relativeLuminanceOf(channels: Rgb): number {
  const [red, green, blue] = channels.map((channel) => {
    const encoded = channel / 255;
    return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  });
  return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722;
}

function opaqueChannels(color: string, role: string): [number, number, number] {
  if (hexAlpha(color) !== 1) {
    throw new TypeError(
      `contrastRatio needs an opaque ${role}; composite the alpha yourself, received ${JSON.stringify(color)}`,
    );
  }
  return rgbChannels(color);
}

/**
 * WCAG 2.x contrast ratio between two opaque colors, from 1 to 21.
 *
 * Both arguments must be opaque `#rgb` or `#rrggbb` (or `#rrggbbaa` with
 * `aa === ff`). A translucent color has no contrast ratio of its own, so
 * passing one throws instead of scoring the dropped alpha: `#00000000` against
 * white is not 21:1, it is whatever the invisible text sits on.
 *
 * @throws {TypeError} when either argument is not an opaque hex color.
 */
export function contrastRatio(foreground: string, background: string): number {
  return contrastRatioOf(opaqueChannels(foreground, "foreground"), opaqueChannels(background, "background"));
}

/**
 * The same ratio from already-parsed channels, so a caller mixing colors can
 * score the exact result instead of the rounded hex the browser never sees.
 *
 * Both arguments are three finite channels from 0 to 255, unrounded values
 * included. Anything else throws rather than returning a number outside the
 * documented 1-to-21 range: this entry point takes numbers, so the hex parser
 * that guards {@link contrastRatio} never sees them.
 *
 * @throws {TypeError} when either argument is not three finite 0-255 channels.
 */
export function contrastRatioOf(foreground: Rgb, background: Rgb): number {
  const a = relativeLuminanceOf(checkedChannels(foreground, "foreground"));
  const b = relativeLuminanceOf(checkedChannels(background, "background"));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
