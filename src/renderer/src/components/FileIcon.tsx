/// <reference types="vite/client" />
// 文件 / 文件夹图标（ui-code）：按 material-icon-theme 的映射规则选图标，和 VS Code 装了 Material Icon Theme 的效果一样
import { memo } from 'react'
import { cx } from './ui'

interface Manifest {
  iconDefinitions: Record<string, { iconPath: string }>
  file: string
  folder: string
  folderExpanded: string
  rootFolder: string
  rootFolderExpanded: string
  fileExtensions: Record<string, string>
  fileNames: Record<string, string>
  folderNames: Record<string, string>
  folderNamesExpanded: Record<string, string>
  rootFolderNames?: Record<string, string>
  rootFolderNamesExpanded?: Record<string, string>
  languageIds: Record<string, string>
}

// 用 glob 导入：JSON 有 450 KB，直接 import 会让 tsc 推导一个巨大的字面量类型
const manifest = Object.values(
  import.meta.glob('../../../../node_modules/material-icon-theme/dist/material-icons.json', { eager: true, import: 'default' })
)[0] as Manifest
// 图标都在 4 KB 以下，构建时内联成 data URL（CSP 的 img-src 允许 data:）
const svgUrls = import.meta.glob('../../../../node_modules/material-icon-theme/icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

let iconUrls: Map<string, string> | undefined
function urlOfIcon(id: string): string | undefined {
  if (!iconUrls) {
    const byFile = new Map<string, string>()
    for (const [k, url] of Object.entries(svgUrls)) byFile.set(baseName(k), url)
    iconUrls = new Map()
    for (const [iconId, def] of Object.entries(manifest?.iconDefinitions ?? {})) {
      const url = byFile.get(baseName(def.iconPath))
      if (url) iconUrls.set(iconId, url)
    }
  }
  return iconUrls.get(id)
}

/** 主题按 VS Code 的语言 id 映射的那些扩展名（fileExtensions 里没有，比如 ts、py） */
const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascriptreact',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'json5',
  jsonl: 'jsonl',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  xsl: 'xsl',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  fish: 'shellscript',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  sql: 'sql',
  swift: 'swift',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  vue: 'vue',
  svelte: 'svelte',
  txt: 'plaintext',
  log: 'log',
  csv: 'csv',
  tsv: 'tsv',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'properties',
  toml: 'toml',
  diff: 'diff',
  patch: 'diff',
  groovy: 'groovy',
  coffee: 'coffeescript',
  fs: 'fsharp',
  fsx: 'fsharp',
  clj: 'clojure',
  pl: 'perl',
  pm: 'perl',
  tex: 'latex',
  m: 'objective-c',
  mm: 'objective-cpp',
  scala: 'scala',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  jl: 'julia',
  vb: 'vb',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'proto',
  tf: 'terraform',
  hcl: 'hcl',
  sol: 'solidity',
  dockerfile: 'dockerfile'
}

const LANG_BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  '.gitignore': 'ignore',
  '.editorconfig': 'editorconfig'
}

function fileIconId(name: string): string {
  const m = manifest
  const lower = name.toLowerCase()
  const byName = m.fileNames[name] ?? m.fileNames[lower]
  if (byName) return byName
  // 复合扩展名优先：a.test.ts 先试 test.ts 再试 ts
  let lastExt = ''
  for (let i = lower.indexOf('.'); i >= 0 && i < lower.length - 1; i = lower.indexOf('.', i + 1)) {
    const ext = lower.slice(i + 1)
    const id = m.fileExtensions[ext]
    if (id) return id
    lastExt = ext.slice(ext.lastIndexOf('.') + 1)
  }
  const lang = LANG_BY_NAME[lower] ?? (lastExt ? LANG_BY_EXT[lastExt] : undefined)
  return (lang && m.languageIds[lang]) || m.file
}

function folderIconId(name: string, open: boolean, root: boolean): string {
  const m = manifest
  const lower = name.toLowerCase()
  if (root) return (open ? m.rootFolderNamesExpanded : m.rootFolderNames)?.[lower] ?? (open ? m.rootFolderExpanded : m.rootFolder)
  return (open ? m.folderNamesExpanded : m.folderNames)[lower] ?? (open ? m.folderExpanded : m.folder)
}

export interface IconOptions {
  isDir?: boolean
  /** 文件夹展开 */
  open?: boolean
  /** 工作区根目录（多根文件树的顶层） */
  root?: boolean
}

const cache = new Map<string, string | undefined>()

/** 图标的 URL（data: 或打包后的资源路径）；主题里找不到时为 undefined */
export function fileIconUrl(name: string, opts: IconOptions = {}): string | undefined {
  if (!manifest) return undefined
  const k = `${opts.isDir ? 1 : 0}${opts.open ? 1 : 0}${opts.root ? 1 : 0}:${name}`
  if (cache.has(k)) return cache.get(k)
  const id = opts.isDir ? folderIconId(name, !!opts.open, !!opts.root) : fileIconId(name)
  const url = urlOfIcon(id) ?? urlOfIcon(opts.isDir ? manifest.folder : manifest.file)
  cache.set(k, url)
  return url
}

/** 按文件名（不含目录）选图标；文件夹传 isDir，展开时传 open */
export const FileIcon = memo(function FileIcon({
  name,
  isDir,
  open,
  root,
  size = 16,
  className
}: {
  name: string
  isDir?: boolean
  open?: boolean
  root?: boolean
  size?: number
  className?: string
}) {
  const url = fileIconUrl(name, { isDir, open, root })
  const style = { width: size, height: size }
  return url ? (
    <img src={url} alt="" draggable={false} className={cx('shrink-0', className)} style={style} />
  ) : (
    <span className={cx('inline-block shrink-0', className)} style={style} />
  )
})
