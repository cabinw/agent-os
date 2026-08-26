import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        menuBar: resolve(import.meta.dirname, "menu-bar.html"),
      },
    },
  },
  clearScreen: false,
  server: {
    host: host ?? false,
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
    proxy: {
      "/hub": {
        target: "http://127.0.0.1:4173",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/hub/u, ""),
        configure(proxy) {
          proxy.on("proxyReq", (request) => {
            request.setHeader("origin", "http://127.0.0.1:4173");
          });
        },
      },
    },
  },
});
