import { defineConfig } from "vite";

const securityHeaders = {
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
