import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        /* 拆分巨型单 bundle（原 1.07MB）：CodeMirror/React/i18n 各自独立 chunk，
           降低首屏一次性解析/编译开销 */
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return;
          if (id.includes('@codemirror') || id.includes('@lezer')) return 'vendor-codemirror';
          if (id.includes('react') || id.includes('scheduler')) return 'vendor-react';
          if (id.includes('i18next') || id.includes('react-i18next')) return 'vendor-i18n';
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
