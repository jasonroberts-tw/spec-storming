import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy /api to the Fastify server so the browser talks same-origin (no CORS),
// and SSE streams pass through untouched.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
