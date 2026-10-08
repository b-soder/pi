import { type Color, colorToRgb, rgbColor } from "@earendil-works/pi-tui";

/** Internal handoff between the parent TUI and the local subagent launcher. */
export const BORDER_COLOR_ENV = "PI_TUI_BORDER_COLOR";
export const BORDER_BRIGHTNESS_ENV = "PI_TUI_BORDER_BRIGHTNESS";

export function readBorderColor(value: string | undefined): string | undefined {
	const color = value?.trim();
	return color && /^#[\da-f]{6}$/i.test(color) ? color.toUpperCase() : undefined;
}

export function readBorderBrightness(value: string | undefined): number {
	if (value === undefined || value.trim() === "") return 1;
	const brightness = Number(value);
	return Number.isFinite(brightness) ? Math.max(0, Math.min(1, brightness)) : 1;
}

function srgbToLinear(channel: number): number {
	const encoded = channel / 255;
	return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
	const clamped = Math.max(0, Math.min(1, channel));
	return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/** Scale light intensity without changing the color's chromaticity. */
export function scaleBorderBrightness(color: Color, brightness: number): Color {
	const factor = Number.isFinite(brightness) ? Math.max(0, Math.min(1, brightness)) : 1;
	if (factor === 1) return color;

	const rgb = colorToRgb(color);
	const scale = (channel: number) => Math.round(linearToSrgb(srgbToLinear(channel) * factor) * 255);
	return rgbColor(scale(rgb.r), scale(rgb.g), scale(rgb.b));
}
