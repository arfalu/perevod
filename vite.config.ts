import { defineConfig } from "vite";

// base: "./" — чтобы сайт работал и на GitHub Pages (в подпапке /perevod/), и локально.
export default defineConfig({
  base: "./",
  build: { target: "es2022" },
});
