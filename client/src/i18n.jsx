import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { LANGS, translate, gameName, serverError, yakuText } from './strings.js';

// Re-exported so the many existing import sites do not have to change, and so
// callers have one obvious place to import i18n from.
export { LANGS, gameName, serverError, yakuText };

// Minimal i18n: one Provider plus useT(). No third-party library — all this needs
// to do is look up a key, interpolate, and remember the choice. One file is easier
// to maintain than a dependency.
//
// Usage: const t = useT(); t('lobby.join') / t('room.needPlayers', { n: 4 })
// A missing key returns the key itself rather than an empty string, so anything
// left untranslated is immediately visible in the UI.
const STORE_KEY = 'lang';

// English is the default. Users who picked Chinese before have it in localStorage,
// so honour that.
function detectInitial() {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved && LANGS[saved]) return saved;
  } catch { /* localStorage can throw in private mode */ }
  return 'en';
}

const LangContext = createContext({ lang: 'en', setLang: () => {}, t: (k) => k });

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(detectInitial);

  const setLang = useCallback((next) => {
    if (!LANGS[next]) return;
    setLangState(next);
    try { localStorage.setItem(STORE_KEY, next); } catch { /* ignore write failures */ }
  }, []);

  const t = useCallback((key, vars) => translate(lang, key, vars), [lang]);

  // Keep <html lang> in step with the language. This one is unambiguous: the document
  // has exactly one language, and it affects screen readers and browser translation
  // prompts. index.html ships the English default; this rewrites it on a switch.
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);

  // The tab title is deliberately NOT set here. It is a single slot that more than one
  // feature may want -- a "your turn" notifier would be the obvious next claimant -- and
  // having the language provider also write it means whoever writes last wins.
  // useDocumentTitle() below owns it instead, so the contention is at least explicit.
  useDocumentTitle(translate(lang, 'app.title'));

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

// ── Document title ───────────────────────────────────────
// document.title is one slot that several features may want at once: the app name,
// and later things like a "your turn" nudge. Rather than let whichever effect ran
// last win, claims are kept in a stack and the most recent one is what shows.
//
// useDocumentTitle(text) claims the title for as long as the component is mounted
// and releases it on unmount, restoring whatever was underneath. The language
// provider holds the bottom claim, so the app name is what remains by default.
const titleClaims = [];

function renderTitle() {
  const top = titleClaims[titleClaims.length - 1];
  if (top !== undefined) document.title = top.text;
}

export function useDocumentTitle(text) {
  // The claim's identity has to survive re-renders so the same entry is updated
  // rather than a new one pushed on every keystroke.
  const claim = useRef(null);
  if (claim.current === null) claim.current = { text };

  useEffect(() => {
    const entry = claim.current;
    titleClaims.push(entry);
    renderTitle();
    return () => {
      const i = titleClaims.indexOf(entry);
      if (i !== -1) titleClaims.splice(i, 1);
      renderTitle();
    };
  }, []);

  useEffect(() => {
    claim.current.text = text;
    renderTitle();
  }, [text]);
}

export function useLang() { return useContext(LangContext); }
export function useT() { return useContext(LangContext).t; }

