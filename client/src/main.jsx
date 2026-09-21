import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { LanguageProvider } from './i18n.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </StrictMode>,
)
// Clean up the legacy service worker and its caches. An early version registered a
// SW, which left updates stuck behind a stale shell.
// The app does not use a SW now -- installability comes from the manifest plus the
// iOS home-screen meta tags, so none is needed.
// This one-off cleanup stays so existing users are not stuck on an old cache; if we
// ever build a real offline PWA, we would introduce a proper SW then.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.getRegistrations()
      .then(registrations => registrations.forEach(registration => registration.unregister()));
    caches?.keys?.()
      .then(names => Promise.all(names.map(name => caches.delete(name))));
  });
}
