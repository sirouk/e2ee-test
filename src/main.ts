import "./styles.css";
import { initE2EE, listModels, sendChat, type ChutesModel } from "./e2eeClient.ts";

const API_KEY_KEY = "chutes-e2ee-test-api-key";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <form class="shell">
    <header>
      <div>
        <h1>Chutes E2EE Test</h1>
        <p>Browser-native TypeScript + WASM client.</p>
      </div>
      <span id="status">loading wasm</span>
    </header>

    <label>
      API key
      <input id="apiKey" type="password" autocomplete="off" placeholder="cpk_..." />
    </label>

    <div class="row">
      <label>
        Model
        <select id="model"></select>
      </label>
      <button id="loadModels" type="button">Load</button>
    </div>

    <label>
      Prompt
      <textarea id="prompt" rows="5">Say hello from inside the Chutes E2EE path.</textarea>
    </label>

    <div class="actions">
      <label class="check"><input id="stream" type="checkbox" /> stream</label>
      <button id="send" type="button">Send E2EE</button>
    </div>

    <pre id="output"></pre>
  </form>
`;

const statusEl = el<HTMLSpanElement>("status");
const apiKeyEl = el<HTMLInputElement>("apiKey");
const modelEl = el<HTMLSelectElement>("model");
const promptEl = el<HTMLTextAreaElement>("prompt");
const outputEl = el<HTMLPreElement>("output");
const streamEl = el<HTMLInputElement>("stream");

apiKeyEl.value = sessionStorage.getItem(API_KEY_KEY) ?? "";
apiKeyEl.addEventListener("input", () => sessionStorage.setItem(API_KEY_KEY, apiKeyEl.value));

initE2EE()
  .then(() => setStatus("wasm ready"))
  .catch((error) => setStatus(`wasm failed: ${error.message ?? error}`));

el<HTMLButtonElement>("loadModels").addEventListener("click", () => run(loadModels));
el<HTMLButtonElement>("send").addEventListener("click", () => run(send));

async function loadModels() {
  setStatus("loading models");
  const models = await listModels(apiKeyEl.value.trim());
  renderModels(models);
  setStatus(`${models.length} models`);
}

async function send() {
  requireKey();
  outputEl.textContent = "";
  setStatus("encrypting");
  const text = await sendChat({
    apiKey: apiKeyEl.value.trim(),
    model: modelEl.value,
    prompt: promptEl.value,
    stream: streamEl.checked,
    onEvent: (line) => {
      if (line === "[DONE]") setStatus("done");
      else outputEl.textContent += line.startsWith("data: ") ? "" : `${line}\n`;
    },
  });
  outputEl.textContent = text || outputEl.textContent;
  setStatus("done");
}

function renderModels(models: ChutesModel[]) {
  modelEl.innerHTML = "";
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = `${model.id}${model.confidential_compute ? "  TEE" : ""}`;
    modelEl.append(option);
  }
  const tee = models.find((m) => m.confidential_compute);
  if (tee) modelEl.value = tee.id;
}

async function run(task: () => Promise<void>) {
  try {
    await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputEl.textContent = message;
    setStatus("error");
  }
}

function requireKey() {
  if (!apiKeyEl.value.trim()) throw new Error("Paste a Chutes API key first.");
}

function setStatus(value: string) {
  statusEl.textContent = value;
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
