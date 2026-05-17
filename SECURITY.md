# Security Model

This is a static browser client. It has no app server and does not store API keys.

## Trust Boundary

The browser is trusted for its own plaintext. Prompt text, the Chutes API key, encrypted request material before upload, and decrypted response text all exist in browser memory during normal use.

Precompiled WASM is not obfuscation or a secrecy boundary. Browsers can download the `.wasm` file, DevTools can disassemble it, and extensions or compromised same-origin JavaScript can observe runtime state. WASM is used here for a compact, portable crypto implementation and for deploys that do not need Rust compilation.

The intended boundary is:

```text
browser plaintext -> browser encrypts -> Chutes E2EE API -> TEE inference -> encrypted response -> browser decrypts
```

## Key Handling

- The Chutes API key lives only in the password input value.
- The app does not write keys to `localStorage`, `sessionStorage`, cookies, URLs, or logs.
- Fetches use `credentials: "omit"`.
- Warmed E2EE instance data is memory-only, keyed by a SHA-256 hash of the current API key plus the selected model's `chute_id`, expires on Chutes' nonce TTL, and is cleared when the API key changes.
- Warmed nonces are consumed once. If Chutes rejects a nonce, the app drops the warmed data for that key/model pair and retries once with fresh discovery.
- Request blobs, response secret keys, and derived stream keys are zeroed after use where JavaScript/WASM gives us direct buffers.

## Deployment

Render must build with:

```bash
npm ci && E2EE_PRECOMPILED_WASM=1 npm run build
```

The live service should use `autoDeployTrigger: checksPass` and publish `dist`.

Production security headers are defined in `render.yaml`, including a restrictive CSP, Trusted Types, `no-referrer`, `nosniff`, frame denial, and a narrow permissions policy.

## Verification

Run these before deploying:

```bash
npm run ci
cargo audit --file wasm/Cargo.lock
gitleaks detect --no-banner --redact --source .
trufflehog filesystem --no-update --no-verification --fail --exclude-paths <(printf 'node_modules\nwasm/target\ndist\n.git\n') .
```

CI also runs a live Chutes smoke test on non-PR runs when `CHUTES_TEST_API_KEY` is configured.
