import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { liveApi } from "./src/live/api";

export default defineConfig(({ mode, isSsrBuild }) => ({
  // liveApi: the /live page's local endpoints (dev server only); reads Dhan credentials from .env, which stay server-side.
  plugins: [react(), liveApi({ ...process.env, ...loadEnv(mode, process.cwd(), "") })],
  server: { port: 5173 },
  build: { copyPublicDir: !isSsrBuild }, // the bot bundle (npm run build:bot) doesn't need the candle files
}));
