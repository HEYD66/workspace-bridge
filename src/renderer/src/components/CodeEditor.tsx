// Monaco 编辑器组件（ui-code）：一个实例挂多个模型
//
// 每个打开的文件是一个独立的 Monaco 模型，切换标签只是换模型，
// 这样撤销历史、光标、滚动位置都留在各自的标签里，和 VS Code 一样。
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EDITOR_FONT, monaco, THEME } from '../lib/monaco'

export interface CodeEditorHandle {
  /** 标签关掉了：把对应的模型丢掉，不然下次打开同一路径会读到旧内容 */
  forget(key: string): void
  /** 某个模型里的正文；模型还没建出来时给 undefined，调用方靠它判断"正文还没进编辑器" */
  value(key: string): string | undefined
  focus(): void
}

export interface CodeEditorProps {
  /** 当前标签的 key（`workspaceId:path`） */
  tabKey: string
  language: string
  /** 磁盘 / 服务端的正文 */
  content: string
  /** 正文从外部替换的信号：只有它变了才把 content 写进模型，否则会把用户正在敲的字冲掉 */
  contentSeq: number
  readOnly?: boolean
  /** 右边的小地图要不要。默认要；右栏里地方窄，不要。只在建编辑器时看一次 */
  minimap?: boolean
  /** 用户敲了字。只传 key：正文要的时候再从模型里取，避免每敲一下就把整篇复制一遍 */
  onChange: (key: string) => void
  /** 跳到某一行，seq 变化表示一次新的跳转请求 */
  reveal?: { line: number; column?: number; seq: number }
}

export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(
  { tabKey, language, content, contentSeq, readOnly, minimap, onChange, reveal },
  ref
) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const models = useRef(new Map<string, monaco.editor.ITextModel>())
  const views = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>())
  /** 每个 key 上次同步过的 contentSeq：切回一个有未保存改动的标签时不能把正文盖掉 */
  const synced = useRef(new Map<string, number>())
  /** 程序自己改写模型时静音：否则刚读完盘就会被标成"有未保存的改动" */
  const mute = useRef(false)
  const keyRef = useRef(tabKey)
  // 回调放进 ref，订阅只建一次就够，不用反复销毁重建
  const changeRef = useRef(onChange)
  changeRef.current = onChange

  const modelFor = (key: string, text: string, lang: string): monaco.editor.ITextModel => {
    const hit = models.current.get(key)
    if (hit && !hit.isDisposed()) return hit
    // uri 只给模型一个稳定身份（语言服务和 diff 靠它区分模型），不会真的去取这个地址
    const model = monaco.editor.createModel(text, lang, monaco.Uri.parse(`inmemory://bridge/${encodeURIComponent(key)}`))
    models.current.set(key, model)
    return model
  }

  useImperativeHandle(ref, () => ({
    forget(key: string) {
      const m = models.current.get(key)
      models.current.delete(key)
      views.current.delete(key)
      synced.current.delete(key)
      // 正在显示的就是它时先摘掉，否则 dispose 会让编辑器指向一个已销毁的模型
      const editor = editorRef.current
      if (editor && editor.getModel() === m) editor.setModel(null)
      if (m && !m.isDisposed()) m.dispose()
    },
    value(key: string) {
      const m = models.current.get(key)
      return m && !m.isDisposed() ? m.getValue() : undefined
    },
    focus() {
      editorRef.current?.focus()
    }
  }))

  // 建一次编辑器，之后只换模型
  useEffect(() => {
    if (!hostRef.current) return
    const editor = monaco.editor.create(hostRef.current, {
      theme: THEME,
      readOnly: !!readOnly,
      model: null,
      fontSize: 13,
      lineHeight: 20,
      fontFamily: EDITOR_FONT,
      fontLigatures: true,
      // 小地图在窄窗口里占地方，但它是"像 VS Code"的关键观感，留着
      minimap: { enabled: minimap !== false, maxColumn: 100, renderCharacters: false, showSlider: 'mouseover' },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      renderLineHighlight: 'all',
      renderWhitespace: 'selection',
      tabSize: 2,
      insertSpaces: true,
      // 关掉自动推断：README 里混着 tab 和空格时不该被悄悄改掉
      detectIndentation: false,
      folding: true,
      foldingHighlight: true,
      showFoldingControls: 'mouseover',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true, highlightActiveIndentation: true },
      padding: { top: 10, bottom: 24 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      stickyScroll: { enabled: true, maxLineCount: 3 },
      wordWrap: 'off',
      contextmenu: true,
      // 浮层挂到 body 上，不然会被各个 flex 容器的 overflow:hidden 裁掉
      fixedOverflowWidgets: true,
      // 自己用 ResizeObserver 控制布局：容器被 display:none 隐藏时不至于反复重排
      automaticLayout: false,
      suggest: { showWords: true, preview: true },
      // 中文注释里大量"看起来像 ASCII"的字符，全角高亮会满屏方框
      unicodeHighlight: { ambiguousCharacters: false },
      occurrencesHighlight: 'singleFile',
      matchBrackets: 'always'
    })
    editorRef.current = editor

    const sub = editor.onDidChangeModelContent(() => {
      if (mute.current) return
      changeRef.current(keyRef.current)
    })

    const ro = new ResizeObserver(() => editor.layout())
    ro.observe(hostRef.current)

    return () => {
      ro.disconnect()
      sub.dispose()
      editor.dispose()
      editorRef.current = null
      for (const m of models.current.values()) if (!m.isDisposed()) m.dispose()
      models.current.clear()
      views.current.clear()
      synced.current.clear()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 切标签：存下上一个模型的视图状态，换上新的，再把新的状态恢复回来
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (keyRef.current !== tabKey) {
      const prev = editor.getModel()
      if (prev) views.current.set(keyRef.current, editor.saveViewState())
      keyRef.current = tabKey
    }
    const model = modelFor(tabKey, content, language)
    if (editor.getModel() !== model) {
      editor.setModel(model)
      const v = views.current.get(tabKey)
      if (v) editor.restoreViewState(v)
    }
    if (synced.current.get(tabKey) === undefined) synced.current.set(tabKey, contentSeq)
  }, [tabKey, language]) // eslint-disable-line react-hooks/exhaustive-deps

  // 正文被外部替换（首次读盘、AI 改完重读、冲突后重载）。
  // 只有这个标签自己的 seq 变了才同步，切标签引起的序号跳变要忽略
  useEffect(() => {
    const last = synced.current.get(tabKey)
    if (last === contentSeq) return
    synced.current.set(tabKey, contentSeq)
    const model = models.current.get(tabKey)
    if (!model || model.isDisposed()) return
    if (model.getValue() !== content) {
      mute.current = true
      try {
        model.setValue(content)
      } finally {
        mute.current = false
      }
    }
  }, [tabKey, contentSeq]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: !!readOnly })
  }, [readOnly])

  // 搜索、快速打开、活动流点"跳到第 N 行"都走这里
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !reveal?.seq) return
    const model = editor.getModel()
    if (!model) return
    const line = Math.min(Math.max(1, reveal.line), model.getLineCount())
    const column = Math.min(Math.max(1, reveal.column ?? 1), model.getLineMaxColumn(line))
    editor.revealLineInCenterIfOutsideViewport(line, monaco.editor.ScrollType.Smooth)
    editor.setPosition({ lineNumber: line, column })
    editor.focus()
  }, [reveal?.seq]) // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={hostRef} className="h-full w-full" />
})
