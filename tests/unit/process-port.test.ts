import { describe, expect, it } from "bun:test";
import { quote } from "../../src/ports/process.port";

/**
 * Every host command this extension builds goes through the shell, so quoting
 * is a correctness concern rather than tidiness: an unquoted name with a space
 * becomes two arguments, which for an uninstaller means acting on the wrong one.
 */
describe("quote", () => {
	it("leaves an ordinary package name alone", () => {
		expect(quote("pi-undo-redo")).toBe("pi-undo-redo");
		expect(quote("@tintinweb/pi-subagents")).toBe("@tintinweb/pi-subagents");
	});

	it("quotes a name carrying a space or a shell metacharacter", () => {
		expect(quote("two words")).toBe("'two words'");
		expect(quote("a;b")).toBe("'a;b'");
		expect(quote("a&b")).toBe("'a&b'");
		expect(quote("$(whoami)")).toBe("'$(whoami)'");
	});

	it("escapes an embedded single quote rather than ending the string", () => {
		expect(quote("it's")).toBe(`'it'\\''s'`);
	});
});
