import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxies API calls to the Bun backend during development,
    // so the frontend can call e.g. fetch("/gmail/labels") directly.
    proxy: {
      "/auth": "http://localhost:3000",
      "/gmail": "http://localhost:3000",
      "/summarize": "http://localhost:3000",
      "/export": "http://localhost:3000",
      "/portfolio": "http://localhost:3000",
    },
  },
});
