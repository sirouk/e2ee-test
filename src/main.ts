import "./styles.css";
import { initE2EE, listModels, sendChat, type ChutesModel } from "./e2eeClient.ts";

const formEl = el<HTMLFormElement>("appForm");
const statusEl = el<HTMLSpanElement>("status");
const apiKeyEl = el<HTMLInputElement>("apiKey");
const modelEl = el<HTMLSelectElement>("model");
const promptEl = el<HTMLTextAreaElement>("prompt");
const outputEl = el<HTMLPreElement>("output");
const streamEl = el<HTMLInputElement>("stream");
const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
let loadedModels: ChutesModel[] = [];

formEl.addEventListener("submit", (event) => event.preventDefault());

initE2EE()
  .then(() => setStatus("wasm ready"))
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    setStatus("error", message);
  });

el<HTMLButtonElement>("loadModels").addEventListener("click", () => run(loadModels));
el<HTMLButtonElement>("send").addEventListener("click", () => run(send));

async function loadModels() {
  setStatus("loading models");
  const models = await listModels(apiKeyEl.value.trim());
  loadedModels = models;
  renderModels(models);
  setStatus(`${models.length} models`);
}

async function send() {
  requireKey();
  outputEl.textContent = "";
  setStatus("encrypting");
  const text = await sendChat({
    apiKey: apiKeyEl.value.trim(),
    model: selectedModel(),
    prompt: promptEl.value,
    stream: streamEl.checked,
    onToken: (text) => {
      outputEl.textContent += text;
    },
  });
  outputEl.textContent = text || outputEl.textContent;
  setStatus("done");
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

function selectedModel() {
  const model = loadedModels.find((item) => item.id === modelEl.value);
  if (!model) throw new Error("Load models first.");
  return model;
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
