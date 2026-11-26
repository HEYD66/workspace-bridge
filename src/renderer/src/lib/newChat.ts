// 「新会话」页的小状态：输入框的草稿用哪个键、怎么把光标放进去
/** 「新会话」页的草稿和待发图片挂在这个假频道 id 上（每个项目一份）；它不是真的频道，不会发给主进程 */
export const newChatKey = (workspaceId: string): string => `new:${workspaceId}`

/** 把光标放进「新会话」页的输入框（页面可能刚要渲染出来，等一帧） */
export function focusNewChat(): void {
  requestAnimationFrame(() => document.getElementById('group-composer')?.focus())
}
