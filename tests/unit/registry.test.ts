import { afterEach, describe, expect, it } from "bun:test";
import { lookupNpmVersion } from "../../src/ports/registry.port";

let server: Bun.Server<undefined> | undefined;
const saved = process.env.MAINTAIN_PLUGINS_REGISTRY;

afterEach(() => {
	server?.stop(true);
	server = undefined;
	if (saved === undefined) delete process.env.MAINTAIN_PLUGINS_REGISTRY;
	else process.env.MAINTAIN_PLUGINS_REGISTRY = saved;
});

describe("lookupNpmVersion", () => {
	it("gives up on a registry that accepts the request and never answers", async () => {
		// idleTimeout 0: the server itself never hangs up, so only the client's
		// own deadline can end this.
		server = Bun.serve({ port: 0, idleTimeout: 0, fetch: () => new Promise<Response>(() => {}) });
		process.env.MAINTAIN_PLUGINS_REGISTRY = `http://127.0.0.1:${server.port}`;

		// Unknown, not a throw: the caller then falls back to the cached version.
		expect(await lookupNpmVersion("some-plugin", 200)).toBeUndefined();
	});

	it("reads the newest version from a registry that answers", async () => {
		server = Bun.serve({ port: 0, fetch: () => Response.json({ version: "1.2.3" }) });
		process.env.MAINTAIN_PLUGINS_REGISTRY = `http://127.0.0.1:${server.port}`;

		expect(await lookupNpmVersion("some-plugin", 200)).toBe("1.2.3");
	});
});
