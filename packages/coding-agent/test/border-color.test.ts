import { colorToHex, parseColor } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
	readBorderBrightness,
	readBorderColor,
	resolveModelBorderColor,
	scaleBorderBrightness,
} from "../src/modes/interactive/border-color.ts";

describe("subagent border color", () => {
	test("reads only a valid six-digit color override", () => {
		expect(readBorderColor("#a1B2c3")).toBe("#A1B2C3");
		expect(readBorderColor(" #123456 ")).toBe("#123456");
		expect(readBorderColor("#abc")).toBeUndefined();
		expect(readBorderColor("#123456; echo unsafe")).toBeUndefined();
	});

	test("resolves exact provider/model color mappings and ignores unknown or invalid colors", () => {
		const colors = {
			"github-copilot/gpt-6-luna": "#00FFFF",
			"github-copilot/gpt-6.1-sol": "not-a-color",
		};

		expect(resolveModelBorderColor(colors, "github-copilot", "gpt-6-luna")).toBe("#00FFFF");
		expect(resolveModelBorderColor(colors, "github-copilot", "gpt-6.1-sol")).toBeUndefined();
		expect(resolveModelBorderColor(colors, "github-copilot", "unknown-model")).toBeUndefined();
		expect(resolveModelBorderColor(colors, undefined, "gpt-6-luna")).toBeUndefined();
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
