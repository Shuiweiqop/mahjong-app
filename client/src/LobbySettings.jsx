import { ui } from './ui';
import { useT } from './i18n.jsx';

// Game settings panel in the lobby.
// - Host: can edit; changes are reported through onChange(config), which emits set_config
// - Everyone else: a read-only view of the current settings
// props: lobby (carries config and configSchema), isHost, onChange
export default function LobbySettings({ lobby, isHost, onChange }) {
  const t = useT();
  const schema = lobby?.configSchema;
  // Label and hint for each setting: prefer the translation, and fall back to the text
  // the server sent when the key is missing. That way a game module can add a config
  // option before its translation exists without the UI showing a raw key.
  const schemaText = (key, suffix, fallback) => {
    const k = `cfg.${key}${suffix}`;
    const out = t(k);
    return out === k ? fallback : out;
  };
  if (!schema) return null;
  const cfg = lobby?.config || {};

  // Generic settings panel: renders from the type in configSchema and knows nothing
  // about any specific game.
  //   type:'toggle'  -> a switch
  //   type:'options' -> a row of value buttons (phase durations and the like)
  // A game module adding a config option only changes configSchema; this stays as is.
  // Draw & Guess has its own options (word bank / custom words) which still use the
  // bespoke layout below -- drawSeconds is what tells the two apart.
  const genericKeys = Object.keys(schema)
    .filter((k) => schema[k]?.type === 'toggle' || schema[k]?.type === 'options');
  if (genericKeys.length && !schema.drawSeconds) {
    return (
      <div style={ui.card}>
        <label style={ui.label}>{t('settings.title')}{!isHost && t('settings.hostOnly')}</label>
        {genericKeys.map((k) => {
          const item = schema[k];
          const val = cfg[k] ?? item.default;
          const label = schemaText(k, '', item.label || k);
          const hint = item.hint ? schemaText(k, '.hint', item.hint) : null;

          if (item.type === 'toggle') {
            return (
              <label key={k} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0',
                                       cursor: isHost ? 'pointer' : 'default' }}>
                <input type="checkbox" checked={!!val} disabled={!isHost} style={{ marginTop: 3 }}
                  onChange={(e) => onChange({ ...cfg, [k]: e.target.checked })} />
                <span>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{label}</div>
                  {hint && <div style={{ color: 'var(--muted)', fontSize: 12 }}>{hint}</div>}
                </span>
              </label>
            );
          }

          return (
            <div key={k} style={{ padding: '8px 0' }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{label}</div>
              {hint && (
                <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 6 }}>{hint}</div>
              )}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                {item.options.map((opt) => (
                  <button key={opt} disabled={!isHost}
                    onClick={() => onChange({ ...cfg, [k]: opt })}
                    style={{
                      padding: '5px 12px', borderRadius: 999, fontSize: 13, fontWeight: 700,
                      border: '1px solid var(--border)', cursor: isHost ? 'pointer' : 'default',
                      background: val === opt ? 'var(--primary)' : 'var(--surface-2)',
                      color: val === opt ? '#fff' : 'var(--muted)',
                    }}>{opt}{item.unit || ''}</button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  const drawSeconds = cfg.drawSeconds ?? schema.drawSeconds.default;
  const roundsPerPlayer = cfg.roundsPerPlayer ?? schema.roundsPerPlayer.default;
  // Older servers do not send wordLang; fall back so the control simply does not render
  const wordLang = cfg.wordLang ?? schema.wordLang?.default;
  const categories = cfg.categories || [];

  const set = (patch) => onChange({ ...cfg, ...patch });

  const pill = (active, onClick, label, key) => (
    <button key={key} disabled={!isHost} onClick={onClick}
      style={{
        padding: '6px 14px', borderRadius: 999, cursor: isHost ? 'pointer' : 'default',
        border: '1px solid var(--border)', fontWeight: 700, fontSize: 13,
        background: active ? 'var(--primary)' : 'var(--surface-2)',
        color: active ? '#fff' : 'var(--muted)',
      }}>{label}</button>
  );

  return (
    <div style={ui.card}>
      <label style={ui.label}>{t('settings.title')}{!isHost && t('settings.hostOnly')}</label>

      {/* Which word bank the room draws from. This is a room-wide setting, not the
          viewer's UI language: everyone has to be guessing the same word. */}
      {schema.wordLang && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}>{t('settings.wordLang')}</div>
          <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 6 }}>
            {t('settings.wordLangHint')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {schema.wordLang.options.map((code) =>
              pill(wordLang === code, () => set({ wordLang: code }), t(`settings.wordLang.${code}`), code))}
          </div>
        </div>
      )}

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, marginBottom: 6 }}>{t('settings.roundsPerPlayer')}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {schema.roundsPerPlayer.options.map((n) =>
            pill(roundsPerPlayer === n, () => set({ roundsPerPlayer: n }), t('settings.roundsUnit', { n }), n))}
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, marginBottom: 6 }}>{t('settings.drawTime')}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {schema.drawSeconds.options.map((s) =>
            pill(drawSeconds === s, () => set({ drawSeconds: s }), `${s}s`, s))}
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, marginBottom: 6 }}>
          {t('settings.categories')} <span style={{ color: 'var(--muted)', fontSize: 12 }}>{t('settings.categoriesHint')}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {schema.categories.map((c) => {
            const on = categories.includes(c);
            // The category value is the server's word-bank key, so only the display name is
            // translated -- the original value is what gets submitted
            const catLabel = t(`cat.${c}`) === `cat.${c}` ? c : t(`cat.${c}`);
            return pill(on, () => {
              const next = on ? categories.filter((x) => x !== c) : [...categories, c];
              set({ categories: next });
            }, catLabel, c);
          })}
        </div>
      </div>

      <div>
        <div style={{ fontSize: 13, marginBottom: 6 }}>
          {t('settings.customWords')} <span style={{ color: 'var(--muted)', fontSize: 12 }}>{t('settings.customWordsHint')}</span>
        </div>
        {isHost ? (
          <textarea
            style={{ ...ui.input, minHeight: 70, resize: 'vertical', marginBottom: 0, fontFamily: 'inherit' }}
            placeholder={t('settings.customPlaceholder')}
            defaultValue={(cfg.customWords || []).join(', ')}
            onBlur={(e) => {
              const words = e.target.value.split(/[,，\n]/).map((w) => w.trim()).filter(Boolean);
              set({ customWords: words });
            }}
          />
        ) : (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>
            {(cfg.customWords || []).length
              ? t('settings.customCount', { n: cfg.customWords.length })
              : t('settings.usingCategories')}
          </p>
        )}
      </div>
    </div>
  );
}
