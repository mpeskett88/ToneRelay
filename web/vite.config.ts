import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../hxbridge/static",
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
  test: {
    environment: "node",
  },
});
