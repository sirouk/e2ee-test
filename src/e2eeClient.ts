import initWasm, {
  build_e2ee_request,
  decrypt_response,
  decrypt_stream_chunk,
  decrypt_stream_init,
  type InitInput,
} from "./wasm/chutes_e2ee_wasm.js";

const API_BASE = "https://api.chutes.ai";
const LLM_BASE = "https://llm.chutes.ai";
const E2E_PATH = "/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 30_000;
const INVOKE_TIMEOUT_MS = 300_000;

export type ChutesModel = {
  id: string;
  chute_id: string;
  confidential_compute?: boolean;
};

type InstanceInfo = {
  instance_id: string;
  e2e_pubkey: string;
  nonces: string[];
};

type E2EEBuildResult = {
  blob: Uint8Array | number[];
  response_sk: Uint8Array | number[];
};

type ChatArgs = {
  apiKey: string;
  model: ChutesModel;
  prompt: string;
  stream: boolean;
  onToken?: (text: string) => void;
};

let wasmReady: Promise<void> | undefined;

export function initE2EE(moduleOrPath?: InitInput | Promise<InitInput>) {
  wasmReady ||= initWasm(moduleOrPath).then(() => undefined);
  return wasmReady;
}

export async function listModels(apiKey: string): Promise<ChutesModel[]> {
  const headers = apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : undefined;
  const res = await fetchWithTimeout(
    `${LLM_BASE}/v1/models`,
    { credentials: "omit", headers, mode: "cors" },
    REQUEST_TIMEOUT_MS,
  );
  if (!res.ok) throw await responseError("models", res);

  const body: unknown = await res.json();
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  return data
    .filter(isChutesModel)
    .filter((model) => model.id.endsWith("-TEE"))
    .sort(compareModels);
}

export async function sendChat(args: ChatArgs): Promise<string> {
  await initE2EE();
  const apiKey = args.apiKey.trim();
  if (!apiKey) throw new Error("Paste a Chutes API key first.");
  if (!args.model.chute_id) throw new Error("Selected model is missing a chute id.");

  let blob: Uint8Array | undefined;
  let responseSk: Uint8Array | undefined;

  try {
    const payload = {
      model: args.model.id,
      messages: [{ role: "user", content: args.prompt }],
      stream: args.stream,
    };
    const instance = await getInstance(apiKey, args.model.chute_id);
    const encrypted = build_e2ee_request(
      instance.e2e_pubkey,
      JSON.stringify(payload),
    ) as E2EEBuildResult;
    blob = bytes(encrypted.blob);
    responseSk = bytes(encrypted.response_sk);

    const res = await fetchWithTimeout(
      `${API_BASE}/e2e/invoke`,
      {
        body: blob as unknown as BodyInit,
        credentials: "omit",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/octet-stream",
          "X-Chute-Id": args.model.chute_id,
          "X-Instance-Id": instance.instance_id,
          "X-E2E-Nonce": instance.nonce,
          "X-E2E-Path": E2E_PATH,
          "X-E2E-Stream": String(args.stream),
        },
        method: "POST",
        mode: "cors",
      },
      INVOKE_TIMEOUT_MS,
    );

    if (!res.ok) throw await responseError("invoke", res);
    if (args.stream) return await readStream(res, responseSk, args.onToken);

    const decrypted = decrypt_response(new Uint8Array(await res.arrayBuffer()), responseSk);
    return extractChatContent(JSON.parse(decrypted));
  } finally {
    blob?.fill(0);
    responseSk?.fill(0);
  }
}

export function extractChatContent(body: unknown): string {
  return chatChoiceContent(body) ?? JSON.stringify(body, null, 2);
}

export function collectText(line: string) {
  if (!line.startsWith("data: ")) return "";
  try {
    return chatChoiceContent(JSON.parse(line.slice(6))) ?? "";
  } catch {
    return "";
  }
}

async function getInstance(apiKey: string, chuteId: string): Promise<InstanceInfo & { nonce: string }> {
  const res = await fetchWithTimeout(
    `${API_BASE}/e2e/instances/${encodeURIComponent(chuteId)}`,
    {
      credentials: "omit",
      headers: { Authorization: `Bearer ${apiKey}` },
      mode: "cors",
    },
    REQUEST_TIMEOUT_MS,
  );
  if (!res.ok) throw await responseError("instances", res);

  const body: unknown = await res.json();
  const instances = isRecord(body) && Array.isArray(body.instances) ? body.instances : [];
  const instance = instances.filter(isInstanceInfo).find((item) => item.nonces.some(Boolean));
  const nonce = instance?.nonces.find(Boolean);
  if (!instance || !nonce) throw new Error("no E2EE-capable instances returned");
  return { ...instance, nonce };
}

async function readStream(
  res: Response,
  responseSk: Uint8Array,
  onToken?: (text: string) => void,
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("stream response has no body");

  const decoder = new TextDecoder();
  let buffer = "";
  let streamKey: Uint8Array | undefined;
  let output = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) break;
        const result = processSseLine(buffer.slice(0, lineEnd).replace(/\r$/, ""), responseSk, streamKey);
        buffer = buffer.slice(lineEnd + 1);
        if (result.kind === "key") {
          streamKey?.fill(0);
          streamKey = result.key;
        }
        if (result.kind === "done") return output.trim();
        if (result.kind === "line") {
          const token = collectText(result.line);
          output += token;
          if (token) onToken?.(token);
        }
      }
    }

    if (buffer.trim()) {
      const result = processSseLine(buffer.trim(), responseSk, streamKey);
      if (result.kind === "line") output += collectText(result.line);
    }
    return output.trim();
  } finally {
    streamKey?.fill(0);
  }
}

function processSseLine(
  line: string,
  responseSk: Uint8Array,
  streamKey?: Uint8Array,
): { kind: "skip" } | { kind: "done" } | { kind: "key"; key: Uint8Array } | { kind: "line"; line: string } {
  if (!line.startsWith("data: ")) return { kind: "skip" };
  const raw = line.slice(6).trim();
  if (!raw) return { kind: "skip" };
  if (raw === "[DONE]") return { kind: "done" };

  const event: unknown = JSON.parse(raw);
  if (!isRecord(event)) return { kind: "skip" };
  if (typeof event.e2e_init === "string") {
    return { kind: "key", key: bytes(decrypt_stream_init(responseSk, event.e2e_init)) };
  }
  if (typeof event.e2e === "string") {
    if (!streamKey) throw new Error("received E2EE chunk before stream init");
    return { kind: "line", line: decrypt_stream_chunk(event.e2e, streamKey) };
  }
  if (event.usage) return { kind: "skip" };
  if (event.e2e_error) return { kind: "line", line: `data: ${JSON.stringify({ error: event.e2e_error })}` };
  return { kind: "skip" };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function responseError(name: string, res: Response) {
  const text = await res.text().catch(() => "");
  const detail = text ? ` ${text.slice(0, 500)}` : "";
  return new Error(`${name} failed: ${res.status}${detail}`);
}

function compareModels(a: ChutesModel, b: ChutesModel) {
  return Number(!!b.confidential_compute) - Number(!!a.confidential_compute) || a.id.localeCompare(b.id);
}

function chatChoiceContent(body: unknown) {
  if (!isRecord(body)) return undefined;
  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  if (!isRecord(choice)) return undefined;
  const message = isRecord(choice.message) ? choice.message.content : undefined;
  if (typeof message === "string") return message;
  const delta = isRecord(choice.delta) ? choice.delta.content : undefined;
  return typeof delta === "string" ? delta : undefined;
}

function isChutesModel(value: unknown): value is ChutesModel {
  return isRecord(value) && typeof value.id === "string" && typeof value.chute_id === "string";
}

function isInstanceInfo(value: unknown): value is InstanceInfo {
  return (
    isRecord(value) &&
    typeof value.instance_id === "string" &&
    typeof value.e2e_pubkey === "string" &&
    Array.isArray(value.nonces) &&
    value.nonces.every((nonce) => typeof nonce === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function bytes(value: Uint8Array | number[]): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}
