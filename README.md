# Chutes E2EE Browser Test

Small browser-native E2EE test client for Chutes. The UI is TypeScript/Vite; the protocol crypto lives in Rust/WASM.

![Chutes E2EE browser flow](docs/e2ee-flow.svg)

See [SECURITY.md](SECURITY.md) for the browser trust model, deployment checks, and hardening notes.

Requires Node 24. Source WASM compilation also needs a stable Rust toolchain with `wasm32-unknown-unknown`.

## Run

```bash
npm install
npm run wasm
npm run dev
```

Open the Vite URL, paste a Chutes API key, choose a model, and send a prompt.
The key is kept in the input only; it is not stored in localStorage/sessionStorage or committed anywhere.

The model choice drives E2EE discovery. The app warms only the selected model's `chute_id`, keeps the returned instance public key and one-time nonces in memory, consumes each nonce once, and refreshes them according to Chutes' discovery TTL. If the API key or selected model changes, the next request uses that key/model pair's own discovery path.

## WASM Mode

By default, `npm run wasm` compiles the Rust crypto source with `wasm-pack`.
For deploy or browser-only testing, set `E2EE_PRECOMPILED_WASM=1` to use the checked-in artifacts in `src/wasm/` instead:

```bash
E2EE_PRECOMPILED_WASM=1 npm run build
```

The helper script is also available directly:

```bash
npm run wasm:precompiled
npm run build:precompiled
```

CI tests precompiled mode from a clean checkout before rebuilding from Rust source. The Rust toolchain is pinned in `rust-toolchain.toml`; source builds can still produce different WASM bytes across host triples, so deployment uses the committed precompiled artifact.

This flag only controls whether the build re-compiles Rust or ships the checked-in WASM. It is not a browser secrecy boundary: DevTools can download and disassemble WASM, and the browser still owns the runtime, plaintext inputs, API key, and decrypted outputs.

## Check

```bash
cargo test --manifest-path wasm/Cargo.toml
cargo clippy --manifest-path wasm/Cargo.toml --all-targets -- -D warnings
npm run check:precompiled
npm run build:precompiled
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
