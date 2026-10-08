import { colorToHex, parseColor } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { readBorderBrightness, readBorderColor, scaleBorderBrightness } from "../src/modes/interactive/border-color.ts";

describe("subagent border color", () => {
	test("reads only a valid six-digit color override", () => {
		expect(readBorderColor("#a1B2c3")).toBe("#A1B2C3");
		expect(readBorderColor(" #123456 ")).toBe("#123456");
		expect(readBorderColor("#abc")).toBeUndefined();
		expect(readBorderColor("#123456; echo unsafe")).toBeUndefined();
	});

	test("defaults invalid brightness to full and clamps valid numbers", () => {
		expect(readBorderBrightness(undefined)).toBe(1);
		expect(readBorderBrightness("0.5")).toBe(0.5);
		expect(readBorderBrightness("2")).toBe(1);
		expect(readBorderBrightness("-1")).toBe(0);
		expect(readBorderBrightness("invalid")).toBe(1);
	});

	test("scales light intensity in linear sRGB while preserving chromaticity", () => {
		expect(colorToHex(scaleBorderBrightness(parseColor("#808080"), 0.5))).toBe("#5c5c5c");
		expect(colorToHex(scaleBorderBrightness(parseColor("#ff0000"), 0.5))).toBe("#bc0000");
		expect(colorToHex(scaleBorderBrightness(parseColor("#4080c0"), 1))).toBe("#4080c0");
	});
});
