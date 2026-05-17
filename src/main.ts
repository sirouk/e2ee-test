import "./styles.css";
import {
  clearE2EEPrefetches,
  initE2EE,
  listModels,
  prefetchE2EEInstance,
  sendChat,
  type ChutesModel,
} from "./e2eeClient.ts";

const formEl = el<HTMLFormElement>("appForm");
const statusEl = el<HTMLSpanElement>("status");
const apiKeyEl = el<HTMLInputElement>("apiKey");
const modelEl = el<HTMLSelectElement>("model");
const promptEl = el<HTMLTextAreaElement>("prompt");
const outputEl = el<HTMLPreElement>("output");
const streamEl = el<HTMLInputElement>("stream");
const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
let loadedModels: ChutesModel[] = [];
let lastApiKey = "";

formEl.addEventListener("submit", (event) => event.preventDefault());
apiKeyEl.addEventListener("input", () => {
  const apiKey = apiKeyEl.value.trim();
  if (apiKey === lastApiKey) return;
  lastApiKey = apiKey;
  clearE2EEPrefetches();
});
modelEl.addEventListener("change", () => {
  void warmSelectedModel(true);
});

initE2EE()
  .then(() => setStatus("wasm ready"))
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    setStatus("error", message);
  });

el<HTMLButtonElement>("loadModels").addEventListener("click", () => run(loadModels));
el<HTMLButtonElement>("send").addEventListener("click", () => run(send));

async function loadModels() {
  syncApiKeyCache();
  setStatus("loading models");
  const models = await listModels(apiKeyEl.value.trim());
  loadedModels = models;
  renderModels(models);
  setStatus(`${models.length} models`);
  void warmSelectedModel(true);
}

async function send() {
  syncApiKeyCache();
  requireKey();
  outputEl.textContent = "";
  const text = await sendChat({
    apiKey: apiKeyEl.value.trim(),
    model: selectedModel(),
    prompt: promptEl.value,
    stream: streamEl.checked,
    onStatus: setStatus,
    onToken: (text) => {
      outputEl.textContent += text;
    },
  });
  outputEl.textContent = text || outputEl.textContent;
  setStatus("done");
  void warmSelectedModel(false);
}

function renderModels(models: ChutesModel[]) {
  modelEl.replaceChildren();
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.id;
    modelEl.append(option);
  }
  const tee = models.find((m) => m.confidential_compute) ?? models[0];
  if (tee) modelEl.value = tee.id;
}

async function run(task: () => Promise<void>) {
  try {
    setBusy(true);
    await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputEl.textContent = message;
    setStatus("error", message);
  } finally {
    setBusy(false);
  }
}

function requireKey() {
  if (!apiKeyEl.value.trim()) throw new Error("Paste a Chutes API key first.");
}

function syncApiKeyCache() {
  const apiKey = apiKeyEl.value.trim();
  if (apiKey === lastApiKey) return;
  lastApiKey = apiKey;
  clearE2EEPrefetches();
}

function selectedModel() {
  const model = loadedModels.find((item) => item.id === modelEl.value);
  if (!model) throw new Error("Load models first.");
  return model;
}

async function warmSelectedModel(showStatus: boolean) {
  const apiKey = apiKeyEl.value.trim();
  const model = loadedModels.find((item) => item.id === modelEl.value);
  if (!apiKey || !model?.chute_id) return;

  try {
    await prefetchE2EEInstance({
      apiKey,
      chuteId: model.chute_id,
      onStatus: showStatus ? setStatus : undefined,
    });
  } catch (error) {
    if (showStatus) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus("warm failed", message);
    }
  }
}

function setStatus(value: string, detail = "") {
  statusEl.textContent = value;
  statusEl.dataset.state = value === "error" ? "error" : "ok";
  if (detail) {
    statusEl.dataset.tip = detail;
    statusEl.title = detail;
  } else {
    delete statusEl.dataset.tip;
    statusEl.removeAttribute("title");
  }
}

function setBusy(value: boolean) {
  for (const button of buttons) button.disabled = value;
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
