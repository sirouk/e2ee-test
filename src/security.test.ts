import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const trackedSource = ["src/main.ts", "src/e2eeClient.ts"];
const renderYaml = readFileSync("render.yaml", "utf8");

describe("security hardening", () => {
  it("keeps runtime code away from HTML injection sinks", () => {
    for (const path of trackedSource) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(/\b(?:innerHTML|outerHTML|insertAdjacentHTML|eval|Function)\b/);
    }
  });

  it("ships a tight production CSP", () => {
    expect(renderYaml).toContain("connect-src 'self' https://api.chutes.ai https://llm.chutes.ai");
    expect(renderYaml).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(renderYaml).toContain("script-src-attr 'none'");
    expect(renderYaml).toContain("style-src-attr 'none'");
    expect(renderYaml).toContain("worker-src 'none'");
    expect(renderYaml).toContain("require-trusted-types-for 'script'");
    expect(renderYaml).not.toContain("'unsafe-inline'");
    expect(renderYaml).not.toContain("'unsafe-eval'");
  });
});
