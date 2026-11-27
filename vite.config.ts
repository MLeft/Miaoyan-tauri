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
        { src: "node_modules/dompurify/dist/purify.min.js", dest: "js", rename: { stripBase: true } },
        { src: "node_modules/pdfjs-dist/cmaps", dest: "pdfjs", rename: { stripBase: 2 } },
        { src: "node_modules/pdfjs-dist/standard_fonts", dest: "pdfjs", rename: { stripBase: 2 } },
        { src: "node_modules/pdfjs-dist/wasm", dest: "pdfjs", rename: { stripBase: 2 } },
        { src: "node_modules/pdfjs-dist/iccs", dest: "pdfjs", rename: { stripBase: 2 } },
      ],
    }),
  ],
  clearScreen: false,
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
