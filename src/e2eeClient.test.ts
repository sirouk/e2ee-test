import { afterEach, describe, expect, it, vi } from "vitest";
import { collectText, extractChatContent, listModels } from "./e2eeClient.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
