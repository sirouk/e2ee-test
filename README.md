# Chutes E2EE Browser Test

Small browser-native E2EE test client for Chutes. The UI is TypeScript/Vite; the protocol crypto lives in Rust/WASM.

![Chutes E2EE browser flow](docs/e2ee-flow.svg)

Requires Node 24. Source WASM compilation also needs a stable Rust toolchain with `wasm32-unknown-unknown`.

## Run

```bash
npm install
npm run wasm
npm run dev
```

Open the Vite URL, paste a Chutes API key, choose a model, and send a prompt.
The key is kept in the input only; it is not stored in localStorage/sessionStorage or committed anywhere.

## WASM Mode

By default, `npm run wasm` compiles the Rust crypto source with `wasm-pack`.
For deploy or browser-only testing, set `E2EE_PRECOMPILED_WASM=1` to use the checked-in artifacts in `src/wasm/` instead:

```bash
E2EE_PRECOMPILED_WASM=1 npm run build
```

This flag only controls whether the build re-compiles Rust or ships the precompiled WASM. It is not a browser secrecy boundary; the browser still owns the runtime and can inspect its own inputs and outputs.

## Check

```bash
cargo test --manifest-path wasm/Cargo.toml
cargo clippy --manifest-path wasm/Cargo.toml --all-targets -- -D warnings
npm run check
npm run build:precompiled
npm run build
npm audit --audit-level=high
```

CI runs the same deterministic checks on every push and pull request. A live Chutes smoke test runs on pushes and manual workflow runs when the `CHUTES_TEST_API_KEY` GitHub secret is configured. Use a scoped, low-quota key for that secret.

This app needs Chutes CORS to allow `https://chutes-e2ee-test.onrender.com` on:

- `GET /e2e/instances/*`
- `POST /e2e/invoke`
- request headers: `Authorization`, `Content-Type`, `X-Chute-Id`, `X-Instance-Id`, `X-E2E-Nonce`, `X-E2E-Stream`, `X-E2E-Path`

`render.yaml` deploys this as the `chutes-e2ee-test` static site and sets the production security headers.
