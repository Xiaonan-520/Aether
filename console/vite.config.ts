import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  // served by the gateway under /console — asset URLs must be relative to it
  base: "/console/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/v1": "http://127.0.0.1:8080",
      "/healthz": "http://127.0.0.1:8080",
      "/captcha": "http://127.0.0.1:8080",
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, "../dist-console"),
    emptyOutDir: true,
  },
})
