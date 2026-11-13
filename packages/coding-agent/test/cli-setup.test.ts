import { describe, expect, it } from "vitest";
import { buildProcessTitle } from "../src/cli/setup.ts";

describe("buildProcessTitle", () => {
	it("keeps the plain application name when identity flags are absent", () => {
		expect(buildProcessTitle("pi", ["--help", "a prompt"])).toBe("pi");
	});

	it("emits both identities in stable order", () => {
		expect(buildProcessTitle("pi", ["--name", "worker", "--session-id", "session"])).toBe(
			"pi --session-id session --name worker",
		);
	});

	it("emits either identity by itself", () => {
		expect(buildProcessTitle("pi", ["--session-id", "session"])).toBe("pi --session-id session");
		expect(buildProcessTitle("pi", ["--name", "worker"])).toBe("pi --name worker");
	});

	it("does not interpret equals forms because the CLI parser does not support them", () => {
		expect(buildProcessTitle("pi", ["--session-id=session", "--name=worker"])).toBe("pi");
	});

	it("omits values containing whitespace or control characters", () => {
		expect(buildProcessTitle("pi", ["--session-id", "bad id", "--name", "worker"])).toBe("pi --name worker");
		expect(buildProcessTitle("pi", ["--session-id", "bad\nvalue"])).toBe("pi");
		expect(buildProcessTitle("pi", ["--name", "bad\u007fvalue"])).toBe("pi");
	});
});
