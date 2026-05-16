# Chutes E2EE Browser Test

Small browser-native E2EE test client for Chutes. The UI is TypeScript/Vite; the protocol crypto lives in Rust/WASM.

## Run

```bash
npm install
npm run wasm
npm run dev
```

Open the Vite URL, paste a Chutes API key, choose a model, and send a prompt.

This app needs Chutes CORS to allow `https://chutes-e2ee-test.onrender.com` on:

- `GET /e2e/instances/*`
- `POST /e2e/invoke`
- request headers: `Authorization`, `Content-Type`, `X-Chute-Id`, `X-Instance-Id`, `X-E2E-Nonce`, `X-E2E-Stream`, `X-E2E-Path`
