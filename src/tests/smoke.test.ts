import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };

describe("scaffold", () => {
  it("has the expected package identity", () => {
    expect(packageJson.name).toBe("@bex-co/muse-code-acp");
    expect(packageJson.bin["muse-code-acp"]).toBe("dist/index.js");
  });
});
