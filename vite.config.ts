import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [
    react(),
    tailwindcss(),
    // PDF.js 运行时资源：中文字体映射(cmaps)、标准字体、WASM 图像解码、ICC 色彩配置随包本地化
    viteStaticCopy({
      targets: [
        { src: "node_modules/pdfjs-dist/cmaps", dest: "pdfjs" },
        { src: "node_modules/pdfjs-dist/standard_fonts", dest: "pdfjs" },
        { src: "node_modules/pdfjs-dist/wasm", dest: "pdfjs" },
        { src: "node_modules/pdfjs-dist/iccs", dest: "pdfjs" },
      ],
    }),
  ],
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
          if (id.includes('pdfjs-dist')) return 'vendor-pdfjs';
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
