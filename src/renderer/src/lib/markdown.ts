// 对话里模型输出的 Markdown：marked 转 HTML，DOMPurify 清掉脚本、事件属性和危险链接
import createDOMPurify from 'dompurify'
import { Marked } from 'marked'

const marked = new Marked({ gfm: true, breaks: true })

// 单独一个实例，钩子不影响别处
const purify = createDOMPurify(window)
purify.addHook('afterSanitizeAttributes', (node) => {
  // 链接交给系统浏览器：主进程只放行新窗口打开的 http(s) 地址，页面内跳转一律拦下
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Markdown → 清洗过的 HTML，可以直接放进 dangerouslySetInnerHTML */
export function renderMarkdown(src: string): string {
  if (!src) return ''
  let html: string
  try {
    html = marked.parse(src, { async: false })
  } catch {
    html = `<pre><code>${escapeHtml(src)}</code></pre>`
  }
  // 图片不显示：CSP 不放行外部图片，留着只会是破图
  return purify.sanitize(html, { FORBID_TAGS: ['style', 'img', 'form', 'button', 'iframe'], FORBID_ATTR: ['style'] })
}

/** 渲染结果的样式（没有 typography 插件，用子元素选择器写） */
export const MARKDOWN_CLASS = [
  'selectable text-[13px] leading-relaxed break-words text-fg',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
  '[&_p]:my-2',
  '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold',
  '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-[14px] [&_h2]:font-semibold',
  '[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-[13px] [&_h3]:font-semibold',
  '[&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:font-semibold',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5',
  '[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2',
  '[&_strong]:font-semibold',
  '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-muted',
  '[&_hr]:my-3 [&_hr]:border-line-soft',
  '[&_code]:rounded [&_code]:bg-hover [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[12px]',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-line-soft [&_pre]:bg-canvas [&_pre]:p-3 [&_pre]:leading-normal [&_pre]:text-[#c9d1d9]',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_table]:my-2 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-xs',
  '[&_th]:border [&_th]:border-line [&_th]:bg-hover [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1'
].join(' ')
