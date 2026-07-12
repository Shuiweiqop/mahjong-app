import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
// 清理历史遗留的 service worker 与缓存(早期版本注册过 SW,曾导致更新卡旧壳)。
// 现阶段本应用不使用 SW —— 可安装性由 manifest + iOS 主屏 meta 提供,无需 SW。
// 保留这段一次性清理,确保老用户不被旧缓存卡住;将来若要做离线 PWA(C 档)再引入正规 SW。
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.getRegistrations()
      .then(registrations => registrations.forEach(registration => registration.unregister()));
    caches?.keys?.()
      .then(names => Promise.all(names.map(name => caches.delete(name))));
  });
}
