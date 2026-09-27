import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 相对路径可同时支持用户主页与项目主页两种 GitHub Pages 地址。
  base: "./",
});
