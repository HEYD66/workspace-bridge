// 必须排第一个：用浏览器从远端链接打开时，这里补上 window.bridge，后面的界面代码才有东西可调
import './remoteBridge'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import { InstantTips } from './components/InstantTips'
import { UnsavedGuard } from './components/UnsavedGuard'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {/* 顶栏和右栏的按钮说明：鼠标移上去马上出来 */}
    <InstantTips />
    {/* 有没保存的改动时，关窗口先问一句 */}
    <UnsavedGuard />
  </StrictMode>
)
