import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [react()],
  server: { port: 5173 },
  build: { copyPublicDir: !isSsrBuild }, // the bot bundle (npm run build:bot) doesn't need the candle files
}));
