import { defineConfig } from "vite";

export default defineConfig({
  // Capacitor serves the built assets from the app bundle, so every asset
  // reference has to be relative rather than root-absolute.
  base: "./",
  build: { outDir: "dist" }
});
