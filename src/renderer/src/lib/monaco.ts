/// <reference types="vite/client" />
// Monaco 的一次性初始化（ui-code）：worker、主题、按扩展名推断语言
//
// 界面用 app:// 协议加载（见 src/main/index.ts 的 serveRenderer），所以 worker 可以是
// 普通的同源脚本，不用内联成 blob。这里用 `?worker&url` 让 Vite 单独打包各个 worker
// 并给出它的地址，再按 Monaco 传进来的 label 分派：
//   - 编辑器自己的通用 worker（editorWorkerService）：词法建议、链接识别、diff
//   - 各语言服务的 worker：折叠、符号、配色取色、TS/JSON 诊断
// 不分派的话 Monaco 会退回它内置的 `?esm` data-URL 方案，那个在 bundler 下取不到依赖，
// 控制台会报 "Failed to load worker script"。
import * as monaco from 'monaco-editor'
import editorWorkerUrl from 'monaco-editor/editor/editor.worker?worker&url'
import jsonWorkerUrl from 'monaco-editor/language/json/json.worker?worker&url'
import cssWorkerUrl from 'monaco-editor/language/css/css.worker?worker&url'
import htmlWorkerUrl from 'monaco-editor/language/html/html.worker?worker&url'
import tsWorkerUrl from 'monaco-editor/language/typescript/ts.worker?worker&url'

interface WorkerEnv {
  getWorker?(workerId: string, label: string): Worker
}

;(globalThis as { MonacoEnvironment?: WorkerEnv }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    const url =
      label === 'json'
        ? jsonWorkerUrl
        : label === 'css' || label === 'scss' || label === 'less'
          ? cssWorkerUrl
          : label === 'html' || label === 'handlebars' || label === 'razor'
            ? htmlWorkerUrl
            : label === 'typescript' || label === 'javascript'
              ? tsWorkerUrl
              : editorWorkerUrl
    return new Worker(url, { type: 'module', name: label })
  }
}

export const THEME = 'bridge-dark'

/** 界面上所有编辑器共用的字体栈：先挑等宽编程字体，中文回落到系统字体 */
export const EDITOR_FONT = '"Cascadia Code", "JetBrains Mono", Consolas, "Microsoft YaHei Mono", "Microsoft YaHei", monospace'

// 按扩展名 / 文件名反查 Monaco 的语言 id。语言清单来自 Monaco 自己注册的那份，
// 不用在这里维护一张会过期的映射表
let extIndex: Map<string, string> | undefined
let nameIndex: Map<string, string> | undefined

function buildIndex(): void {
  extIndex = new Map()
  nameIndex = new Map()
  for (const lang of monaco.languages.getLanguages()) {
    for (const ext of lang.extensions ?? []) extIndex.set(ext.toLowerCase(), lang.id)
    for (const name of lang.filenames ?? []) nameIndex.set(name.toLowerCase(), lang.id)
  }
}

/** 工作区相对路径 → Monaco 语言 id；不认识时给纯文本 */
export function languageOf(path: string): string {
  if (!extIndex || !nameIndex) buildIndex()
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const byName = nameIndex?.get(name)
  if (byName) return byName
  // 1067.test.ts 这种复合扩展名要先试 .test.ts 再试 .ts
  for (let i = name.indexOf('.'); i >= 0 && i < name.length - 1; i = name.indexOf('.', i + 1)) {
    const id = extIndex?.get(name.slice(i))
    if (id) return id
  }
  return 'plaintext'
}

// 编辑器内部 UI 的配色跟界面主题对齐：底色和 index.css 的 canvas 一样（#171717）
monaco.editor.defineTheme(THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'e6edf3' },
    { token: 'comment', foreground: '7d8590', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'ff7b72' },
    { token: 'keyword.control', foreground: 'ff7b72' },
    { token: 'string', foreground: 'a5d6ff' },
    { token: 'string.escape', foreground: '79c0ff' },
    { token: 'number', foreground: '79c0ff' },
    { token: 'regexp', foreground: 'a5d6ff' },
    { token: 'operator', foreground: 'ff7b72' },
    { token: 'delimiter', foreground: '8b949e' },
    { token: 'type', foreground: 'ffa657' },
    { token: 'type.identifier', foreground: 'ffa657' },
    { token: 'namespace', foreground: 'ffa657' },
    { token: 'function', foreground: 'd2a8ff' },
    { token: 'identifier', foreground: 'e6edf3' },
    { token: 'variable', foreground: 'e6edf3' },
    { token: 'tag', foreground: '7ee787' },
    { token: 'attribute.name', foreground: '79c0ff' },
    { token: 'attribute.value', foreground: 'a5d6ff' },
    { token: 'key', foreground: '79c0ff' },
    { token: 'strong', foreground: 'e6edf3', fontStyle: 'bold' },
    { token: 'emphasis', foreground: 'e6edf3', fontStyle: 'italic' },
    { token: 'invalid', foreground: 'ffa198' }
  ],
  colors: {
    'editor.background': '#171717',
    'editor.foreground': '#e6edf3',
    'editorCursor.foreground': '#58a6ff',
    'editor.selectionBackground': '#264f78',
    'editor.inactiveSelectionBackground': '#264f7866',
    'editor.lineHighlightBackground': '#1c1c1c',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#484f58',
    'editorLineNumber.activeForeground': '#c9d1d9',
    'editorIndentGuide.background1': '#2b2b2b',
    'editorIndentGuide.activeBackground1': '#2f2f2f',
    'editorBracketMatch.background': '#1f6feb33',
    'editorBracketMatch.border': '#1f6feb',
    'editorWhitespace.foreground': '#2f2f2f',
    'editorWidget.background': '#1c1c1c',
    'editorWidget.border': '#2f2f2f',
    'editorSuggestWidget.background': '#1c1c1c',
    'editorSuggestWidget.border': '#2f2f2f',
    'editorSuggestWidget.selectedBackground': '#1f6feb40',
    'editorHoverWidget.background': '#1c1c1c',
    'editorHoverWidget.border': '#2f2f2f',
    'editorGutter.background': '#171717',
    'editorOverviewRuler.border': '#00000000',
    'scrollbarSlider.background': '#484f5880',
    'scrollbarSlider.hoverBackground': '#6e768180',
    'scrollbarSlider.activeBackground': '#8b949e99',
    'minimap.background': '#171717',
    'input.background': '#171717',
    'focusBorder': '#1f6feb'
  }
})

// 只做查看和轻改，不接项目里的 tsconfig，语义校验会把所有 import 标红，所以关掉。
// 语法错误照旧显示（未闭合的括号、写坏的表达式）
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })

export { monaco }

/** 常见的只读二进制扩展名：这些不往编辑器里塞，直接给占位提示 */
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'tif', 'tiff',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'exe', 'dll', 'so', 'dylib', 'a', 'lib', 'obj', 'o', 'class', 'wasm', 'node',
  'mp3', 'mp4', 'wav', 'ogg', 'flac', 'm4a', 'avi', 'mkv', 'mov', 'webm',
  'sqlite', 'db', 'bin', 'dat', 'pdb', 'map'
])

/** 一看扩展名就知道不能当文本打开的 */
export function looksBinary(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  return ext ? BINARY_EXT.has(ext) : false
}
