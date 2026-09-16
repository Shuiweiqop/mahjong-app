import { LANGS, useLang } from './i18n.jsx';

// Language switch: one button per language, with the active one highlighted.
// With only two languages, buttons take one tap fewer than a dropdown and are an
// easier target on a phone.
// Each screen positions this itself (under the title on the sign-in screen, in the
// header in the lobby, in the top bar inside a room).
export default function LangToggle({ style }) {
  const { lang, setLang } = useLang();
  return (
    <div style={{
      display: 'inline-flex', gap: 2, padding: 2, borderRadius: 999,
      background: 'var(--surface-2)', border: '1px solid var(--border)', ...style,
    }}>
      {Object.entries(LANGS).map(([code, label]) => {
        const on = lang === code;
        return (
          <button key={code} onClick={() => setLang(code)}
            aria-pressed={on}
            style={{
              padding: '4px 10px', borderRadius: 999, border: 'none', cursor: 'pointer',
              fontSize: 12, fontWeight: 700,
              background: on ? 'var(--primary)' : 'transparent',
              color: on ? '#fff' : 'var(--muted)',
            }}>{label}</button>
        );
      })}
    </div>
  );
}
