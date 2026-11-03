import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "node:path";

// Two pages: the landing page at / and the flasher at /flash/.
// BERGA_BASE sets the base path for hosting under a sub-path (GitHub Pages project
// site: BERGA_BASE=/bergamota-farita/). Default "/" for root hosting (Cloudflare).
export default defineConfig({
  base: process.env.BERGA_BASE || "/",
  plugins: [svelte()],
  build: {
    target: "es2022",
    // fonts and images stay files: the CSP allows them only from this origin
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        landing: resolve(import.meta.dirname, "index.html"),
        flash: resolve(import.meta.dirname, "flash/index.html"),
        log: resolve(import.meta.dirname, "log/index.html"),
      },
    },
  },
});
