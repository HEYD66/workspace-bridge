import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 当前正在处理的工具调用是哪个 AI 发的（成员 id）。MCP 工具的统一包装里设置，
 * 文件工具的路径保护（PathGuard 的 fence）按它判断这个 AI 不能进的工作区目录。
 * 不在工具调用里（工作台自己的操作）时没有值，不加限制
 */
export const agentScope = new AsyncLocalStorage<string>()

/** 工作区成员名单：去重、只留非空字符串；不是数组返回 undefined（= 所有 AI 都能用） */
export function normalizeMembers(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))]
}
