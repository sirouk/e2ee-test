# Chutes E2EE Browser Test

Small browser-native E2EE test client for Chutes. The UI is TypeScript/Vite; the protocol crypto lives in Rust/WASM.

![Chutes E2EE browser flow](docs/e2ee-flow.svg)

Requires Node 24 and a stable Rust toolchain with `wasm32-unknown-unknown`.

## Run

```bash
npm install
npm run wasm
npm run dev
```

Open the Vite URL, paste a Chutes API key, choose a model, and send a prompt.
The key is kept in the input only; it is not stored in localStorage/sessionStorage or committed anywhere.

## Check

```bash
cargo test --manifest-path wasm/Cargo.toml
cargo clippy --manifest-path wasm/Cargo.toml --all-targets -- -D warnings
npm run check
npm run build
npm audit --audit-level=high
```

CI runs the same deterministic checks on every push and pull request. A live Chutes smoke test runs on pushes and manual workflow runs when the `CHUTES_TEST_API_KEY` GitHub secret is configured. Use a scoped, low-quota key for that secret.

This app needs Chutes CORS to allow `https://chutes-e2ee-test.onrender.com` on:

- `GET /e2e/instances/*`
- `POST /e2e/invoke`
- request headers: `Authorization`, `Content-Type`, `X-Chute-Id`, `X-Instance-Id`, `X-E2E-Nonce`, `X-E2E-Stream`, `X-E2E-Path`

`render.yaml` deploys this as the `chutes-e2ee-test` static site and sets the production security headers.
