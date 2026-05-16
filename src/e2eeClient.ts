import initWasm, {
  build_e2ee_request,
  decrypt_response,
  decrypt_stream_chunk,
  decrypt_stream_init,
} from "./wasm/chutes_e2ee_wasm.js";

const API_BASE = "https://api.chutes.ai";
const LLM_BASE = "https://llm.chutes.ai";
const E2E_PATH = "/v1/chat/completions";

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
  model: string;
  prompt: string;
  stream: boolean;
  onEvent?: (line: string) => void;
};

let wasmReady: Promise<void> | undefined;

export function initE2EE() {
  wasmReady ||= initWasm().then(() => undefined);
  return wasmReady;
}

export async function listModels(apiKey: string): Promise<ChutesModel[]> {
  const res = await fetch(`${LLM_BASE}/v1/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!res.ok) throw new Error(`models failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return (body.data ?? [])
    .filter((m: ChutesModel) => m.id && m.chute_id)
    .sort((a: ChutesModel, b: ChutesModel) => Number(!!b.confidential_compute) - Number(!!a.confidential_compute) || a.id.localeCompare(b.id));
}

export async function sendChat(args: ChatArgs): Promise<string> {
  await initE2EE();
  const models = await listModels(args.apiKey);
  const selected = models.find((m) => m.id === args.model);
  if (!selected) throw new Error(`model not found: ${args.model}`);

  const payload = {
    model: selected.id,
    messages: [{ role: "user", content: args.prompt }],
    stream: args.stream,
  };

  const instance = await getInstance(args.apiKey, selected.chute_id);
  const encrypted = build_e2ee_request(instance.e2e_pubkey, JSON.stringify(payload)) as E2EEBuildResult;
  const blob = bytes(encrypted.blob);
  const responseSk = bytes(encrypted.response_sk);

  const res = await fetch(`${API_BASE}/e2e/invoke`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/octet-stream",
      "X-Chute-Id": selected.chute_id,
      "X-Instance-Id": instance.instance_id,
      "X-E2E-Nonce": instance.nonce,
      "X-E2E-Stream": String(args.stream),
      "X-E2E-Path": E2E_PATH,
    },
    body: blob as unknown as BodyInit,
  });

  if (!res.ok) throw new Error(`invoke failed: ${res.status} ${await res.text()}`);
  if (args.stream) return readStream(res, responseSk, args.onEvent);

  const decrypted = decrypt_response(new Uint8Array(await res.arrayBuffer()), responseSk);
  const body = JSON.parse(decrypted);
  return body.choices?.[0]?.message?.content ?? JSON.stringify(body, null, 2);
}

async function getInstance(apiKey: string, chuteId: string): Promise<InstanceInfo & { nonce: string }> {
  const res = await fetch(`${API_BASE}/e2e/instances/${chuteId}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!res.ok) throw new Error(`instances failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const instance = (body.instances as InstanceInfo[] | undefined)?.find((i) => i.nonces?.length);
  if (!instance) throw new Error("no E2EE-capable instances returned");
  return { ...instance, nonce: instance.nonces[0] };
}

async function readStream(
  res: Response,
  responseSk: Uint8Array,
  onEvent?: (line: string) => void,
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("stream response has no body");

  const decoder = new TextDecoder();
  let buffer = "";
  let streamKey: Uint8Array | undefined;
  let output = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    for (;;) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) break;
      const line = buffer.slice(0, lineEnd).replace(/\r$/, "");
      buffer = buffer.slice(lineEnd + 1);

      const decrypted = processSseLine(line, responseSk, streamKey);
      if (decrypted.kind === "key") streamKey = decrypted.key;
      if (decrypted.kind === "line") {
        output += collectText(decrypted.line);
        onEvent?.(decrypted.line);
      }
      if (decrypted.kind === "done") onEvent?.("[DONE]");
    }
  }

  return output.trim();
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

  const event = JSON.parse(raw);
  if (event.e2e_init) return { kind: "key", key: bytes(decrypt_stream_init(responseSk, event.e2e_init)) };
  if (event.e2e) {
    if (!streamKey) throw new Error("received E2EE chunk before stream init");
    return { kind: "line", line: decrypt_stream_chunk(event.e2e, streamKey) };
  }
  if (event.usage) return { kind: "line", line };
  if (event.e2e_error) return { kind: "line", line: `data: ${JSON.stringify({ error: event.e2e_error })}` };
  return { kind: "skip" };
}

function collectText(line: string) {
  if (!line.startsWith("data: ")) return "";
  try {
    const event = JSON.parse(line.slice(6));
    return event.choices?.[0]?.delta?.content ?? event.choices?.[0]?.message?.content ?? "";
  } catch {
    return "";
  }
}

function bytes(value: Uint8Array | number[]): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}
