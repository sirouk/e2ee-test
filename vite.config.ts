import { defineConfig } from "vite";

const csp = [
  "default-src 'self'",
  "base-uri 'none'",
  "child-src 'none'",
  "connect-src 'self' https://api.chutes.ai https://llm.chutes.ai ws: http://localhost:*",
  "font-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "img-src 'self' data:",
  "manifest-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "style-src-attr 'none'",
  "worker-src 'none'",
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
