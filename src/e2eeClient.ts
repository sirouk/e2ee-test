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
const DEFAULT_NONCE_TTL_SECONDS = 55;
const NONCE_TTL_SAFETY_SECONDS = 5;
const MAX_PREFETCHED_NONCES = 6;

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

type E2EEStatus = (status: string) => void;

type ChatArgs = {
  apiKey: string;
  model: ChutesModel;
  prompt: string;
  stream: boolean;
  onToken?: (text: string) => void;
  onStatus?: E2EEStatus;
};

type InstanceLease = Omit<InstanceInfo, "nonces"> & {
  expiresAt: number;
  nonce: string;
};

type CachedInstanceLease = InstanceLease;

let wasmReady: Promise<void> | undefined;
let cacheGeneration = 0;
const prefetchedInstances = new Map<string, CachedInstanceLease[]>();
const pendingPrefetches = new Map<string, Promise<void>>();
const usedNonceKeys = new Set<string>();

export function initE2EE(moduleOrPath?: InitInput | Promise<InitInput>) {
  wasmReady ||= initWasm(moduleOrPath).then(() => undefined);
  return wasmReady;
}

export function clearE2EEPrefetches() {
  cacheGeneration += 1;
  prefetchedInstances.clear();
  pendingPrefetches.clear();
  usedNonceKeys.clear();
}

export async function prefetchE2EEInstance(args: {
  apiKey: string;
  chuteId: string;
  onStatus?: E2EEStatus;
}) {
  const apiKey = args.apiKey.trim();
  if (!apiKey || !args.chuteId) return;

  const key = await prefetchKey(apiKey, args.chuteId);
  prunePrefetched(key);
  if (prefetchedInstances.get(key)?.length) {
    args.onStatus?.("ready next");
    return;
  }

  const pending = pendingPrefetches.get(key);
  if (pending) return pending;

  const generation = cacheGeneration;
  const prefetch = (async () => {
    args.onStatus?.("warming e2ee");
    const leases = await fetchInstanceLeases(apiKey, args.chuteId);
    if (generation !== cacheGeneration) return;
    putPrefetched(key, leases);
    if (prefetchedInstances.get(key)?.length) args.onStatus?.("ready next");
  })().finally(() => {
    if (pendingPrefetches.get(key) === prefetch) pendingPrefetches.delete(key);
  });

  pendingPrefetches.set(key, prefetch);
  return prefetch;
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
  args.onStatus?.("preparing wasm");
  await initE2EE();
  const apiKey = args.apiKey.trim();
  if (!apiKey) throw new Error("Paste a Chutes API key first.");
  const chuteId = args.model.chute_id;
  if (!chuteId) throw new Error("Selected model is missing a chute id.");

  const payloadJson = JSON.stringify({
    model: args.model.id,
    messages: [{ role: "user", content: args.prompt }],
    stream: args.stream,
  });
  const cacheKey = await prefetchKey(apiKey, chuteId);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let blob: Uint8Array | undefined;
    let responseSk: Uint8Array | undefined;

    try {
      const instance = await getInstance(apiKey, chuteId, args.onStatus, cacheKey);
      args.onStatus?.("encrypting");
      const encrypted = build_e2ee_request(instance.e2e_pubkey, payloadJson) as E2EEBuildResult;
      blob = bytes(encrypted.blob);
      responseSk = bytes(encrypted.response_sk);

      args.onStatus?.("sending request");
      const res = await fetchWithTimeout(
        `${API_BASE}/e2e/invoke`,
        {
          body: blob as unknown as BodyInit,
          credentials: "omit",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/octet-stream",
            "X-Chute-Id": chuteId,
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

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (attempt === 1 && isNonceRejection(res.status, text)) {
          invalidatePrefetched(cacheKey);
          args.onStatus?.("retrying nonce");
          continue;
        }
        throw responseErrorFromText("invoke", res.status, text);
      }

      void prefetchE2EEInstance({ apiKey, chuteId }).catch(() => undefined);
      if (args.stream) return await readStream(res, responseSk, args.onToken, args.onStatus);

      args.onStatus?.("reading response");
      const responseBlob = new Uint8Array(await res.arrayBuffer());
      args.onStatus?.("decrypting response");
      const decrypted = decrypt_response(responseBlob, responseSk);
      return extractChatContent(JSON.parse(decrypted));
    } finally {
      blob?.fill(0);
      responseSk?.fill(0);
    }
  }

  throw new Error("invoke failed after retrying nonce");
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

async function getInstance(
  apiKey: string,
  chuteId: string,
  onStatus?: E2EEStatus,
  cacheKey?: string,
): Promise<InstanceLease> {
  const key = cacheKey ?? (await prefetchKey(apiKey, chuteId));
  const cached = consumePrefetched(key);
  if (cached) {
    onStatus?.("using warm nonce");
    return cached;
  }

  const pending = pendingPrefetches.get(key);
  if (pending) {
    onStatus?.("waiting nonce");
    await pending.catch(() => undefined);
    const warmed = consumePrefetched(key);
    if (warmed) {
      onStatus?.("using warm nonce");
      return warmed;
    }
  }

  onStatus?.("fetching instance");
  const leases = await fetchInstanceLeases(apiKey, chuteId);
  const unusedLeases = leases.filter((lease) => !isUsedLease(key, lease));
  const lease = consumeLease(key, unusedLeases[0]);
  putPrefetched(key, unusedLeases.slice(1));
  if (!lease) throw new Error("no E2EE-capable instances returned");
  return lease;
}

async function fetchInstanceLeases(apiKey: string, chuteId: string): Promise<InstanceLease[]> {
  const res = await fetchWithTimeout(
    `${API_BASE}/e2e/instances/${encodeURIComponent(chuteId)}`,
    {
      cache: "no-store",
      credentials: "omit",
      headers: { Authorization: `Bearer ${apiKey}` },
      mode: "cors",
    },
    REQUEST_TIMEOUT_MS,
  );
  if (!res.ok) throw await responseError("instances", res);

  const body: unknown = await res.json();
  const instances = isRecord(body) && Array.isArray(body.instances) ? body.instances : [];
  const ttlSeconds =
    isRecord(body) && typeof body.nonce_expires_in === "number" && Number.isFinite(body.nonce_expires_in)
      ? body.nonce_expires_in
      : DEFAULT_NONCE_TTL_SECONDS;
  const usableTtlSeconds = Math.max(1, ttlSeconds - NONCE_TTL_SAFETY_SECONDS);
  const expiresAt = Date.now() + usableTtlSeconds * 1000;
  const leases = instances.filter(isInstanceInfo).flatMap((instance) =>
    instance.nonces
      .filter(Boolean)
      .map((nonce) => ({
        instance_id: instance.instance_id,
        e2e_pubkey: instance.e2e_pubkey,
        expiresAt,
        nonce,
      })),
  );
  if (!leases.length) throw new Error("no E2EE-capable instances returned");
  return leases;
}

async function readStream(
  res: Response,
  responseSk: Uint8Array,
  onToken?: (text: string) => void,
  onStatus?: E2EEStatus,
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("stream response has no body");

  const decoder = new TextDecoder();
  let buffer = "";
  let streamKey: Uint8Array | undefined;
  let output = "";
  let sawToken = false;

  try {
    onStatus?.("opening stream");
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
          onStatus?.("decrypting stream");
        }
        if (result.kind === "done") {
          onStatus?.("finalizing");
          return output.trim();
        }
        if (result.kind === "line") {
          const token = collectText(result.line);
          output += token;
          if (token) {
            if (!sawToken) onStatus?.("streaming");
            sawToken = true;
            onToken?.(token);
          }
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

function putPrefetched(key: string, leases: InstanceLease[]) {
  prunePrefetched(key);
  const cached = prefetchedInstances.get(key) ?? [];
  const cachedKeys = new Set(cached.map((lease) => nonceKey(key, lease)));

  for (const lease of leases) {
    const keyForNonce = nonceKey(key, lease);
    if (usedNonceKeys.has(keyForNonce) || cachedKeys.has(keyForNonce)) continue;
    cached.push(lease);
    cachedKeys.add(keyForNonce);
    if (cached.length >= MAX_PREFETCHED_NONCES) break;
  }

  if (cached.length) prefetchedInstances.set(key, cached);
  else prefetchedInstances.delete(key);
}

function invalidatePrefetched(key: string) {
  prefetchedInstances.delete(key);
  pendingPrefetches.delete(key);
}

function consumePrefetched(key: string): InstanceLease | undefined {
  prunePrefetched(key);
  const cached = prefetchedInstances.get(key);
  if (!cached?.length) return undefined;
  while (cached.length) {
    const lease = consumeLease(key, cached.shift());
    if (lease) {
      if (!cached.length) prefetchedInstances.delete(key);
      return lease;
    }
  }
  prefetchedInstances.delete(key);
  return undefined;
}

function consumeLease(key: string, lease?: InstanceLease): InstanceLease | undefined {
  if (!lease) return undefined;
  if (lease.expiresAt <= Date.now()) return undefined;
  if (isUsedLease(key, lease)) return undefined;
  usedNonceKeys.add(nonceKey(key, lease));
  return lease;
}

function isUsedLease(key: string, lease: InstanceLease) {
  return usedNonceKeys.has(nonceKey(key, lease));
}

function prunePrefetched(key: string) {
  const cached = prefetchedInstances.get(key);
  if (!cached?.length) return;
  const now = Date.now();
  const fresh = cached.filter((lease) => lease.expiresAt > now);
  if (fresh.length) prefetchedInstances.set(key, fresh);
  else prefetchedInstances.delete(key);
}

function nonceKey(key: string, lease: InstanceLease) {
  return `${key}:${lease.instance_id}:${lease.nonce}`;
}

async function prefetchKey(apiKey: string, chuteId: string) {
  return `${await sha256Hex(apiKey)}:${chuteId}`;
}

async function sha256Hex(value: string) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  return responseErrorFromText(name, res.status, text);
}

function responseErrorFromText(name: string, status: number, text: string) {
  const detail = text ? ` ${text.slice(0, 500)}` : "";
  return new Error(`${name} failed: ${status}${detail}`);
}

function isNonceRejection(status: number, text: string) {
  return status === 403 && text.toLowerCase().includes("nonce");
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
