import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { initE2EE, listModels, sendChat, type ChutesModel } from "./e2eeClient.ts";

const apiKey = process.env.CHUTES_TEST_API_KEY?.trim();
const modelId = process.env.CHUTES_TEST_MODEL?.trim() || "moonshotai/Kimi-K2.6-TEE";
const chuteId = process.env.CHUTES_TEST_CHUTE_ID?.trim();
const liveDescribe = apiKey ? describe : describe.skip;

liveDescribe("live Chutes E2EE smoke", () => {
  const key = apiKey || "";

  beforeAll(async () => {
    const wasm = await readFile(new URL("./wasm/chutes_e2ee_wasm_bg.wasm", import.meta.url));
    await initE2EE(wasm);
  }, 30_000);

  it("streams and decrypts a TEE response", async () => {
    const model = await resolveModel(key);
    const chunks: string[] = [];
    const text = await sendChat({
      apiKey: key,
      model,
      prompt: "Reply with exactly: e2ee smoke ok",
      stream: true,
      onToken: (chunk) => chunks.push(chunk),
    });

    expect(model.id.endsWith("-TEE")).toBe(true);
    expect(chunks.join("").trim().length).toBeGreaterThan(0);
    expect(text.trim().length).toBeGreaterThan(0);
  }, 180_000);
});

async function resolveModel(key: string): Promise<ChutesModel> {
  if (chuteId) {
    return { id: modelId, chute_id: chuteId, confidential_compute: true };
  }

  const models = await listModels(key);
  const model = models.find((item) => item.id === modelId) ?? models[0];
  if (!model) throw new Error("No -TEE models returned by Chutes.");
  return model;
}
