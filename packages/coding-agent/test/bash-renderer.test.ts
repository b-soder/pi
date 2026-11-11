import { describe, expect, it } from "vitest";
import { formatShellTimeout } from "../src/core/tools/renderers/bash.ts";

describe("formatShellTimeout", () => {
	it("formats timeout values supplied in seconds", () => {
		expect(formatShellTimeout(120)).toBe("2m");
		expect(formatShellTimeout(30)).toBe("30s");
	});
});
