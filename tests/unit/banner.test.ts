import { describe, expect, it } from "bun:test";
import { boxBanner } from "../../src/core/banner";

describe("boxBanner", () => {
	it("draws both rules as wide as the widest row, counting ⬆️ as one cell", () => {
		const [top, row, bottom] = boxBanner("Updates", ["⬆️ plugin-a: 1.0.0 -> 2.0.0"]);
		// "│ " + 26 cells (⬆️ is one) = 28 cells; the bottom rule is "╰─" plus 26 dashes.
		expect([...row!].length - 1).toBe(28); // one extra code point: the VS16 of ⬆️
		expect([...bottom!].length).toBe(28);
		expect([...top!].length).toBe(28);
	});
});
