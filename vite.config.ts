import { defineConfig } from "vite";

// 5173 = basketball-sim / 5180 = basketball-phys が使う。vite が黙って別ポートへ移ると
// 別プロジェクトを見てしまうので固定する。
export default defineConfig({
  server: { port: 5190, strictPort: true },
});
