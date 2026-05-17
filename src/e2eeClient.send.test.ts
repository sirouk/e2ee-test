import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./wasm/chutes_e2ee_wasm.js", () => ({
  default: vi.fn(async () => undefined),
  build_e2ee_request: vi.fn(() => ({
    blob: new Uint8Array([1, 2, 3]),
    response_sk: new Uint8Array([4, 5, 6]),
  })),
  decrypt_response: vi.fn(() => JSON.stringify({ choices: [{ message: { content: "ok" } }] })),
  decrypt_stream_chunk: vi.fn(),
  decrypt_stream_init: vi.fn(),
}));

import { clearE2EEPrefetches, sendChat } from "./e2eeClient.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearE2EEPrefetches();
  vi.restoreAllMocks();
});

describe("sendChat", () => {
  it("retries once with fresh discovery when Chutes rejects a nonce", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(instanceBody(["nonce-a", "nonce-b"])),
      new Response("nonce rejected", { status: 403 }),
      jsonResponse(instanceBody(["nonce-c"])),
      new Response(new Uint8Array([7, 8, 9]), { status: 200 }),
    ]);
    const statuses: string[] = [];

    const text = await sendChat({
      apiKey: "test-key",
      model: { id: "model-TEE", chute_id: "chute-a", confidential_compute: true },
      prompt: "hello",
      stream: false,
      onStatus: (status) => statuses.push(status),
    });

    const invokes = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/e2e/invoke"));
    expect(text).toBe("ok");
    expect(invokes).toHaveLength(2);
    expect(headerValue(invokes[0][1], "X-E2E-Nonce")).toBe("nonce-a");
    expect(headerValue(invokes[1][1], "X-E2E-Nonce")).toBe("nonce-c");
    expect(statuses).toEqual([
      "preparing wasm",
      "fetching instance",
      "encrypting",
      "sending request",
      "retrying nonce",
      "fetching instance",
      "encrypting",
      "sending request",
      "reading response",
      "decrypting response",
    ]);
  });
});

function instanceBody(nonces: string[]) {
  return {
    nonce_expires_in: 55,
    instances: [
      {
        instance_id: "instance-a",
        e2e_pubkey: "pubkey",
        nonces,
      },
    ],
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function mockFetchSequence(responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>(async () => responses.shift() ?? jsonResponse(instanceBody(["nonce-warm"])));
  globalThis.fetch = fetchMock;
  return fetchMock;
}

function headerValue(init: RequestInit | undefined, name: string) {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}
