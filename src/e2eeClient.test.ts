import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearE2EEPrefetches,
  collectText,
  extractChatContent,
  listModels,
  prefetchE2EEInstance,
} from "./e2eeClient.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearE2EEPrefetches();
  vi.restoreAllMocks();
});

describe("listModels", () => {
  it("keeps only usable models and sorts TEE models first", async () => {
    const fetchMock = mockFetch({
      data: [
        { id: "z-plain", chute_id: "plain" },
        { id: "b-tee", chute_id: "tee-b", confidential_compute: true },
        { id: "z-plain-TEE", chute_id: "tee-z", confidential_compute: false },
        { id: "missing-chute" },
        { id: "a-tee", chute_id: "tee-a", confidential_compute: true },
        { id: "a-model-TEE", chute_id: "tee-a-model", confidential_compute: true },
      ],
    });

    const models = await listModels(" test-key ");
    const [, init] = fetchMock.mock.calls[0];

    expect(models.map((model) => model.id)).toEqual(["a-model-TEE", "z-plain-TEE"]);
    expect(init?.credentials).toBe("omit");
    expect(init?.mode).toBe("cors");
    expect(init?.headers).toEqual({ Authorization: "Bearer test-key" });
  });

  it("does not send Authorization for public model listing", async () => {
    const fetchMock = mockFetch({ data: [] });

    await listModels("");
    const [, init] = fetchMock.mock.calls[0];

    expect(init?.headers).toBeUndefined();
  });
});

describe("E2EE instance prefetch", () => {
  it("warms one model chute without refetching while a nonce is cached", async () => {
    const fetchMock = mockFetch({
      nonce_expires_in: 55,
      instances: [
        {
          instance_id: "instance-a",
          e2e_pubkey: "pubkey",
          nonces: ["nonce-a", "nonce-b"],
        },
      ],
    });
    const statuses: string[] = [];

    await prefetchE2EEInstance({
      apiKey: " test-key ",
      chuteId: "chute-a",
      onStatus: (status) => statuses.push(status),
    });
    await prefetchE2EEInstance({
      apiKey: "test-key",
      chuteId: "chute-a",
      onStatus: (status) => statuses.push(status),
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(url)).toBe("https://api.chutes.ai/e2e/instances/chute-a");
    expect(init?.cache).toBe("no-store");
    expect(init?.credentials).toBe("omit");
    expect(init?.mode).toBe("cors");
    expect(init?.headers).toEqual({ Authorization: "Bearer test-key" });
    expect(statuses).toEqual(["warming e2ee", "ready next", "ready next"]);
  });

  it("keeps warmed nonces scoped to the current API key and model chute", async () => {
    const fetchMock = mockFetch({
      nonce_expires_in: 55,
      instances: [
        {
          instance_id: "instance-a",
          e2e_pubkey: "pubkey",
          nonces: ["nonce-a"],
        },
      ],
    });

    await prefetchE2EEInstance({ apiKey: "key-a", chuteId: "chute-a" });
    await prefetchE2EEInstance({ apiKey: "key-a", chuteId: "chute-b" });
    await prefetchE2EEInstance({ apiKey: "key-b", chuteId: "chute-a" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.chutes.ai/e2e/instances/chute-a",
      "https://api.chutes.ai/e2e/instances/chute-b",
      "https://api.chutes.ai/e2e/instances/chute-a",
    ]);
  });

  it("expires warmed nonces using the discovery TTL", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch({
      nonce_expires_in: 1,
      instances: [
        {
          instance_id: "instance-a",
          e2e_pubkey: "pubkey",
          nonces: ["nonce-a"],
        },
      ],
    });

    try {
      await prefetchE2EEInstance({ apiKey: "key-a", chuteId: "chute-a" });
      await vi.advanceTimersByTimeAsync(1_001);
      await prefetchE2EEInstance({ apiKey: "key-a", chuteId: "chute-a" });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("chat response helpers", () => {
  it("extracts non-stream and stream chat content", () => {
    expect(extractChatContent({ choices: [{ message: { content: "done" } }] })).toBe("done");
    expect(collectText('data: {"choices":[{"delta":{"content":"hi"}}]}')).toBe("hi");
    expect(collectText('data: {"usage":{"prompt_tokens":1}}')).toBe("");
  });
});

function mockFetch(body: unknown) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status: 200,
    }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}
