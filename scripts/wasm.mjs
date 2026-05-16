import { spawnSync } from "node:child_process";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const precompiled = process.env.E2EE_PRECOMPILED_WASM === "1";
const required = [
  "src/wasm/chutes_e2ee_wasm.js",
  "src/wasm/chutes_e2ee_wasm.d.ts",
  "src/wasm/chutes_e2ee_wasm_bg.wasm",
  "src/wasm/chutes_e2ee_wasm_bg.wasm.d.ts",
];

if (precompiled) {
  for (const path of required) {
    if (!existsSync(path) || statSync(path).size === 0) {
      throw new Error(`missing precompiled WASM artifact: ${path}`);
    }
  }
  console.log("Using checked-in precompiled WASM artifacts.");
} else {
  const result = spawnSync(
    "wasm-pack",
    [
      "build",
      "wasm",
      "--target",
      "web",
      "--out-dir",
      "../src/wasm",
      "--no-pack",
      "--no-opt",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  const generatedIgnore = join("src", "wasm", ".gitignore");
  if (existsSync(generatedIgnore)) {
    unlinkSync(generatedIgnore);
  }
}

if (!existsSync(join("src", "wasm", "chutes_e2ee_wasm_bg.wasm"))) {
  throw new Error("WASM artifact was not produced.");
}
