import { defineConfig } from "vite";

const csp = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "font-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "connect-src 'self' https://api.chutes.ai https://llm.chutes.ai ws: http://localhost:*",
].join("; ");

const securityHeaders = {
  "Content-Security-Policy": csp,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export default defineConfig({
  preview: {
    headers: securityHeaders,
  },
  server: {
    headers: securityHeaders,
    port: 5173,
  },
});
