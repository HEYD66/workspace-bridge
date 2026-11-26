# 第三方代码声明

本项目里有几处代码是从别的开源项目搬来的。这里列出搬了谁的、放在哪、用的什么协议。
搬来的文件开头都留着来源和版权说明。以后再搬别人的代码，请在这里加一节。

## Cate

- 项目：https://github.com/0-AI-UG/cate
- 搬的版本：提交 4ccb512（2026-11-15）
- 协议：MIT
- 搬来的文件（原样，只改了 import 路径）：
  - `src/shared/canvas/geometry.ts`（原 `src/workspace/canvas/contract/geometry.ts`）
  - `src/shared/canvas/arrange.ts`（原 `src/workspace/canvas/contract/arrange.ts`）
  - `src/shared/canvas/placement.ts`（原 `src/workspace/canvas/contract/placement.ts`）
  - `src/shared/canvas/connections.ts`（原 `src/workspace/canvas/contract/connections.ts`）
  - `src/shared/canvas/wheelIntent.ts`（原 `src/shells/desktop/ui/client/layout/canvas/parts/wheelIntent.ts`）
  - `tests/canvasGeometry.test.ts`、`tests/canvasPlacement.test.ts`、`tests/canvasConnections.test.ts`、`tests/canvasWheelIntent.test.ts`（原来和上面的文件放在一起的测试）
- 只学了做法、没有搬代码的：`src/shared/canvasModel.ts` 里「状态只认明确的事件」的规则，来自 Cate 的 `docs/agent-activity.md`。

协议原文：

```
MIT License

Copyright (c) 2026 0-AI UG

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## hivemind

- 项目：https://github.com/dip497/hivemind
- 搬的版本：提交 8e71c3c（2026-11-04）
- 协议：MIT
- 搬来的文件：
  - `src/shared/canvas/frameLayout.ts`（原 `apps/desktop/src/renderer/src/frame-layout.ts`，原样，只在开头加了来源说明）
  - `tests/frameLayout.test.ts`（原 `apps/desktop/tests/unit/frame-layout.test.ts`，测试框架从 node:test 换成 vitest，改了被测文件的路径）
- 只学了做法、没有搬代码的：`src/renderer/src/views/CanvasView.tsx` 里滚轮怎么分缩放和平移、点击留 4 像素的余量，来自它的 `canvas-nodes.tsx` 和 `CanvasView.tsx`。

协议原文：

```
MIT License

Copyright (c) 2026 hivemind contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 千面 Facet

- 项目：https://github.com/HEYD66/facet
- 迁入版本：提交 fbf3a8f（v0.2.24，2026-11-11）
- 协议：MIT
- 迁入文件：`src/main/facet/` 下的 12 个指纹与环境模块文件（详见 `src/main/facet/README.md`）。
