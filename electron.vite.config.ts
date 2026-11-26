import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'

// 入口沿用 electron-vite 约定：src/main/index.ts、src/preload/index.ts、src/renderer/index.html
export default defineConfig({
  // 主进程里有原生模块（node-pty）和一批要按 node_modules 里的真实路径去 require 的依赖，
  // 全打进 bundle 就找不到 .node 文件和 prebuilds 了。externalizeDepsPlugin 让
  // package.json 的 dependencies 保持外部引入，运行时从 node_modules 加载。
  main: {
    plugins: [
      externalizeDepsPlugin(),
      {
        // src/main/facet/ 是从千面 Facet 原样搬来的 CommonJS 文件（指纹）：不打包，原样拷到 out/main/facet/，
        // 运行时用 require 加载（它们之间互相 require，还要按路径读旁边的 .js / .json）
        name: 'wb-copy-facet',
        generateBundle() {
          const dir = path.resolve('src/main/facet')
          for (const f of fs.readdirSync(dir)) {
            if (/\.(cjs|js|json)$/.test(f)) this.emitFile({ type: 'asset', fileName: `facet/${f}`, source: fs.readFileSync(path.join(dir, f)) })
          }
        }
      }
    ]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // 开启 sandbox 的窗口只能加载 CommonJS 预加载脚本
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()]
  }
})
