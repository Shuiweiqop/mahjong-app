import { useState, useCallback } from 'react';
import { parseHand, analyzeHand, calcHK, calcGB, calcTenpai } from './calculator/index.js';
import { useLang, useT, yakuText } from './i18n.jsx';
import LangToggle from './LangToggle.jsx';

// ── Tile helpers ─────────────────────────────────────────
// The suit keys and tile counts are fixed; display names come from the message table (Chinese suit characters, English Characters/Dots/...)
const SUITS_CONFIG = [
  { key: 'm', nums: [1,2,3,4,5,6,7,8,9] },
  { key: 'p', nums: [1,2,3,4,5,6,7,8,9] },
  { key: 's', nums: [1,2,3,4,5,6,7,8,9] },
  { key: 'z', nums: [1,2,3,4,5,6,7] },
];

// The character on the tile face: winds are 1-4, dragons 5-7. Chinese uses the wind and dragon characters;
// English uses single-letter abbreviations (E/S/W/N/R/G/Wh) because the tile face is too narrow for full names.
function tileDisplay(t, suit, num) {
  if (suit !== 'z') return String(num);
  return num <= 4 ? t(`calc.wind.${num}`) : t(`calc.dragon.${num}`);
}
function tileSuitSuffix(t, suit) {
  return suit === 'z' ? '' : t(`calc.suffix.${suit}`);
}
function suitColor(suit) {
  return { m: '#e8b84b', p: '#e85454', s: '#4bce7a', z: '#a78bfa' }[suit];
}

// ── Styles ───────────────────────────────────────────────
const C = {
  wrap:    { maxWidth: 500, margin: '0 auto', padding: '20px 12px' },
  backBtn: {
    background: 'transparent', color: 'var(--muted)',
    border: '1px solid var(--border)', padding: '7px 14px',
    cursor: 'pointer', fontSize: 12, fontFamily: 'DM Mono, monospace', marginBottom: 20,
  },
  title: { color: 'var(--gold)', fontSize: 22, marginBottom: 4 },
  sub:   { color: 'var(--muted)', fontSize: 11, letterSpacing: 1, marginBottom: 16 },

  tabs: { display: 'flex', border: '1px solid var(--border)', marginBottom: 12 },
  tab: (active) => ({
    flex: 1, padding: '10px 0', textAlign: 'center', cursor: 'pointer',
    fontSize: 12, letterSpacing: 1, fontFamily: 'DM Mono, monospace',
    background: active ? 'var(--gold)' : 'var(--surface)',
    color: active ? '#000' : 'var(--muted)', border: 'none',
  }),

  ruleLabel: { fontSize: 10, color: 'var(--muted)', letterSpacing: 2, marginBottom: 6 },
handArea: {
  minHeight: 72, border: '1px solid var(--border)', background: 'var(--surface)',
  padding: '10px 10px 6px', marginBottom: 14,
},
 handCount: {
  fontSize: 10, color: 'var(--muted)', fontFamily: 'DM Mono, monospace',
  textAlign: 'right', marginBottom: 6, display: 'block',
},
  handEmpty: { color: 'var(--muted)', fontSize: 12 },

  handTile: (suit) => ({
    display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', width: 40, height: 50,
    background: '#0f0a00', border: `2px solid ${suitColor(suit)}`,
    borderRadius: 4, cursor: 'pointer', flexShrink: 0,
  }),
  handTileNum: (suit) => ({
    fontSize: 16, fontWeight: 'bold', lineHeight: 1,
    color: suitColor(suit), fontFamily: 'DM Mono, monospace',
  }),
  handTileSuit: (suit) => ({
    fontSize: 9, color: suitColor(suit), opacity: 0.7, lineHeight: 1.2,
  }),

  pickerSection: { marginBottom: 14 },
  pickerLabel:   { fontSize: 10, color: 'var(--muted)', letterSpacing: 2, marginBottom: 6, display: 'block' },
  pickerGrid:    { display: 'flex', flexWrap: 'wrap', gap: 5 },
  pickerTile: (suit, disabled) => ({
    width: 42, height: 52,
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', gap: 1,
    background: disabled ? '#111' : '#1c1200',
    border: `1px solid ${disabled ? '#333' : suitColor(suit)}`,
    borderRadius: 3, cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.3 : 1,
  }),
  pickerTileNum: (suit) => ({
    fontSize: 16, fontWeight: 'bold', lineHeight: 1,
    color: suitColor(suit), fontFamily: 'DM Mono, monospace',
  }),
  pickerTileSuit: (suit) => ({
    fontSize: 9, color: suitColor(suit), opacity: 0.7, lineHeight: 1.2,
  }),
  dot: { fontSize: 8, color: 'var(--gold)', lineHeight: 1 },

  textInput: {
    background: 'var(--surface)', border: '1px solid var(--border)',
    color: 'var(--text)', padding: '12px', width: '100%',
    fontSize: 16, fontFamily: 'DM Mono, monospace', marginBottom: 6, outline: 'none',
  },
  hint: { fontSize: 11, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.8 },

  contextLabel: { fontSize: 10, color: 'var(--muted)', letterSpacing: 1, marginBottom: 6 },
  contextRow:   { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 },
  toggle: (on) => ({
    padding: '7px 14px', fontSize: 11, cursor: 'pointer',
    fontFamily: 'DM Mono, monospace', letterSpacing: 1,
    background: on ? 'var(--red)' : 'var(--surface)',
    color: on ? '#fff' : 'var(--muted)',
    border: `1px solid ${on ? 'var(--red)' : 'var(--border)'}`,
    transition: 'all 0.15s',
  }),

  actionRow: { display: 'flex', gap: 8, marginBottom: 20 },
  calcBtn: {
    flex: 1, padding: 14, background: 'var(--gold)', color: '#000',
    border: 'none', cursor: 'pointer', fontSize: 13, letterSpacing: 1,
    fontFamily: 'DM Mono, monospace',
  },
  clearBtn: {
    padding: '8px 16px', background: 'transparent', color: 'var(--muted)',
    border: '1px solid var(--border)', cursor: 'pointer',
    fontSize: 11, fontFamily: 'DM Mono, monospace',
  },

  errorBox: {
    color: 'var(--red)', fontSize: 13, marginBottom: 12,
    padding: '10px 12px', border: '1px solid var(--red)', background: '#1a0000',
  },

  // Waits
  tenpaiBox: {
    border: '1px solid var(--gold)', background: '#1a1200',
    padding: 16, marginBottom: 12,
  },
  tenpaiTitle: {
    fontSize: 11, color: 'var(--gold)', letterSpacing: 1,
    marginBottom: 10, fontFamily: 'DM Mono, monospace',
  },
  tenpaiGrid: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  tenpaiTile: (suit) => ({
    display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', width: 40, height: 50,
    background: '#0f0a00', border: `2px solid ${suitColor(suit)}`,
    borderRadius: 4, flexShrink: 0,
  }),
  tenpaiNone: { fontSize: 12, color: 'var(--muted)' },

  // Result
  resultBox: (win) => ({
    border: `1px solid ${win ? 'var(--gold)' : '#c0392b'}`,
    background: win ? '#1a1200' : '#1a0000', padding: 16,
  }),
  resultTitle: (win) => ({
    fontSize: 18, fontFamily: 'Noto Serif SC, serif',
    color: win ? 'var(--gold-light)' : '#e74c3c',
    marginBottom: win ? 10 : 0,
  }),
  fanBig: {
    fontSize: 52, fontWeight: 'bold', color: 'var(--gold-light)',
    fontFamily: 'DM Mono, monospace', lineHeight: 1, marginBottom: 14,
  },
  fanUnit: { fontSize: 22, fontFamily: 'Noto Serif SC, serif' },
  yakuRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
    padding: '9px 0', borderTop: '1px solid var(--border)',
  },
  yakuName: { fontSize: 14, color: 'var(--text)', fontFamily: 'Noto Serif SC, serif' },
  yakuDesc: { fontSize: 11, color: 'var(--muted)', marginTop: 2 },
  yakuFan:  { fontSize: 13, color: 'var(--gold)', fontFamily: 'DM Mono, monospace', flexShrink: 0, marginLeft: 8 },
};

// ── Tile Picker ──────────────────────────────────────────
function TilePicker({ hand, onAdd, t }) {
  const used = {};
  for (const tile of hand) {
    const k = `${tile.suit}${tile.num}`;
    used[k] = (used[k] || 0) + 1;
  }
  return (
    <div>
      {SUITS_CONFIG.map(suit => (
        <div key={suit.key} style={C.pickerSection}>
          <span style={C.pickerLabel}>{t(`calc.suit.${suit.key}`)}</span>
          <div style={C.pickerGrid}>
            {suit.nums.map(num => {
              const k   = `${suit.key}${num}`;
              const cnt = used[k] || 0;
              const disabled = cnt >= 4 || hand.length >= 14;
              return (
                <div key={num}
                  style={C.pickerTile(suit.key, disabled)}
                  onClick={() => !disabled && onAdd({ suit: suit.key, num })}
                >
                  <span style={C.pickerTileNum(suit.key)}>{tileDisplay(t, suit.key, num)}</span>
                  <span style={C.pickerTileSuit(suit.key)}>{tileSuitSuffix(t, suit.key)}</span>
                  {cnt > 0 && <span style={C.dot}>{'●'.repeat(cnt)}</span>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Tenpai display ───────────────────────────────────────
function TenpaiBox({ tiles, t }) {
  return (
    <div style={C.tenpaiBox}>
      <div style={C.tenpaiTitle}>{t('calc.tenpaiTitle')}</div>
      {tiles.length === 0 ? (
        <div style={C.tenpaiNone}>{t('calc.notTenpai')}</div>
      ) : (
        <div style={C.tenpaiGrid}>
          {tiles.map((tile, i) => (
            <div key={i} style={C.tenpaiTile(tile.suit)}>
              <span style={C.handTileNum(tile.suit)}>{tileDisplay(t, tile.suit, tile.num)}</span>
              <span style={C.handTileSuit(tile.suit)}>{tileSuitSuffix(t, tile.suit)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Example line: replaces the {hand} placeholder in the message with a gold-highlighted hand string.
// Not interpolated then split -- the raw message is split on the placeholder, so the message table still
// decides the word order (English can put "14 tiles, fan count" after the hand) and the highlighting survives.
function Example({ text, hand }) {
  const [before, after = ''] = text.split('{hand}');
  return (
    <>
      {before}<span style={{ color: 'var(--gold)' }}>{hand}</span>{after}
    </>
  );
}

// ── Main ─────────────────────────────────────────────────
export default function CalculatorScreen({ onBack }) {
  const t = useT();
  const { lang } = useLang();
  const [mode, setMode]           = useState('pick');
  const [rule, setRule]           = useState('hk');
  const [hand, setHand]           = useState([]);
  const [textInput, setTextInput] = useState('');
  const [context, setContext]     = useState({ selfDraw: false, hasOpen: false });
  const [result, setResult]       = useState(null);
  const [tenpai, setTenpai]       = useState(null); // null = not checked, [] = not tenpai, [...] = waiting tiles
  const [error, setError]         = useState(null);
  const [loading, setLoading]     = useState(false);

  const toggleCtx = (k) => setContext(c => ({ ...c, [k]: !c[k] }));

  const previewHand = (() => {
    if (mode !== 'text') return [];
    const { tiles, error: e } = parseHand(textInput);
    return e ? [] : tiles;
  })();

  const displayHand = mode === 'pick' ? hand : previewHand;

  const clearAll = () => {
    setHand([]); setTextInput('');
    setResult(null); setTenpai(null); setError(null);
  };

  const removeFromHand = (idx) => {
    setHand(h => h.filter((_, i) => i !== idx));
    setResult(null); setTenpai(null);
  };

  const handleCalculate = useCallback(() => {
    setResult(null); setTenpai(null); setError(null);

    let tiles;
    if (mode === 'pick') {
      if (hand.length !== 13 && hand.length !== 14) {
        setError({ key: 'calc.needTiles', vars: { n: hand.length } });
        return;
      }
      tiles = hand;
    } else {
      const parsed = parseHand(textInput);
      if (parsed.error) { setError(parsed.error); return; }
      tiles = parsed.tiles;
    }

    // ── 13 tiles: show the waits ─────────────────────────
    if (tiles.length === 13) {
      setLoading(true);
      setTimeout(() => {
        const waiting = calcTenpai(tiles);
        setTenpai(waiting);
        setLoading(false);
      }, 0);
      return;
    }

    // ── 14 tiles: score the fan ──────────────────────────
    const { win, decompositions } = analyzeHand(tiles);
    if (!win) { setResult({ win: false, msgKey: 'calc.noWin' }); return; }

    const calc = rule === 'hk' ? calcHK : calcGB;
    const { fan, yaku, belowMinimum } = calc(decompositions, context);

    if (rule === 'gb' && (belowMinimum || fan === 0)) {
      setResult({ win: false, msgKey: 'calc.belowMinimum' });
      return;
    }
    setResult({ win: true, fan, yaku });
  }, [mode, rule, hand, textInput, context]);

  const buttonLabel = () => {
    const count = displayHand.length;
    if (count === 13) return t('calc.checkTenpai');
    if (count === 14) return t('calc.countFan');
    return t('calc.calcOrTenpai');
  };

  // Errors are stored as { key, vars } and only looked up at render time -- so an error already on screen follows a language switch
  const errText = (e) => (e ? t(e.key, e.vars) : '');

  return (
    // Carries its own scoped color variables (the fan calculator's classic gold/red theme); it neither depends on nor pollutes the platform theme
    <div style={{
      '--gold': '#d4a017', '--gold-light': '#f0c040', '--red': '#c0392b',
      '--surface': '#1c1200', '--border': '#3a2800', '--text': '#f5e6c8',
      '--muted': '#7a6a50', minHeight: '100vh', background: '#0f0a00',
    }}>
    <div style={C.wrap}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
        {onBack && <button style={{ ...C.backBtn, marginBottom: 0 }} onClick={onBack}>{t('common.back')}</button>}
        <LangToggle style={{ marginLeft: 'auto' }} />
      </div>

      <h2 style={C.title}>{t('calc.title')}</h2>
      <p style={C.sub}>{t('calc.sub')}</p>

      {/* Rule selector */}
      <div style={C.ruleLabel}>{t('calc.rule')}</div>
      <div style={C.tabs}>
        <button style={C.tab(rule === 'hk')} onClick={() => { setRule('hk'); setResult(null); setTenpai(null); }}>
          {t('calc.ruleHK')}
        </button>
        <button style={C.tab(rule === 'gb')} onClick={() => { setRule('gb'); setResult(null); setTenpai(null); }}>
          {t('calc.ruleGB')}
        </button>
      </div>

      {/* Input mode */}
      <div style={C.ruleLabel}>{t('calc.inputMode')}</div>
      <div style={C.tabs}>
        <button style={C.tab(mode === 'pick')} onClick={() => { setMode('pick'); setResult(null); setTenpai(null); }}>
          {t('calc.modePick')}
        </button>
        <button style={C.tab(mode === 'text')} onClick={() => { setMode('text'); setResult(null); setTenpai(null); }}>
          {t('calc.modeText')}
        </button>
      </div>

      {/* Hand display */}
      <div style={C.handArea}>
  <span style={C.handCount}>{displayHand.length} / 14</span>
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
    {displayHand.length === 0 ? (
      <span style={C.handEmpty}>
        {mode === 'pick' ? t('calc.handEmptyPick') : t('calc.handEmptyText')}
      </span>
    ) : (
      displayHand.map((tile, i) => (
        <div key={i} style={C.handTile(tile.suit)}
          onClick={mode === 'pick' ? () => removeFromHand(i) : undefined}
          title={mode === 'pick' ? t('calc.tapToRemove') : ''}
        >
          <span style={C.handTileNum(tile.suit)}>{tileDisplay(t, tile.suit, tile.num)}</span>
          <span style={C.handTileSuit(tile.suit)}>{tileSuitSuffix(t, tile.suit)}</span>
        </div>
      ))
    )}
  </div>
</div>  

      {/* Input */}
      {mode === 'pick' ? (
        <TilePicker hand={hand} t={t}
          onAdd={tile => { setHand(h => [...h, tile]); setResult(null); setTenpai(null); }} />
      ) : (
        <>
          <input style={C.textInput} value={textInput}
            onChange={e => { setTextInput(e.target.value); setResult(null); setTenpai(null); }}
            placeholder={t('calc.textPlaceholder')}
          />
          <div style={C.hint}>
            {t('calc.formatLine')}<br />
            {t('calc.honourLine')}<br />
            {/* Passing no vars returns the raw message with the {hand} placeholder intact, which Example splits and highlights */}
            <Example text={t('calc.example14')} hand="123m456p789s1155z" /><br />
            <Example text={t('calc.example13')} hand="123m456p789s155z" />
          </div>
        </>
      )}

      {/* Context (only relevant for 14-tile calculation) */}
      <div style={{ marginTop: 12 }}>
        <div style={C.contextLabel}>{t('calc.context')}</div>
        <div style={C.contextRow}>
          <button style={C.toggle(context.selfDraw)} onClick={() => toggleCtx('selfDraw')}>{t('calc.selfDraw')}</button>
          <button style={C.toggle(context.hasOpen)}  onClick={() => toggleCtx('hasOpen')}>{t('calc.hasOpen')}</button>
        </div>
      </div>

      {/* Actions */}
      <div style={C.actionRow}>
        <button style={C.calcBtn} onClick={handleCalculate} disabled={loading}>
          {loading ? t('calc.calculating') : buttonLabel()}
        </button>
        <button style={C.clearBtn} onClick={clearAll}>{t('common.clear')}</button>
      </div>

      {/* Error */}
      {error && <div style={C.errorBox}>{errText(error)}</div>}

      {/* Tenpai result */}
      {tenpai !== null && <TenpaiBox tiles={tenpai} t={t} />}

      {/* Fan result */}
      {result && (
        <div style={C.resultBox(result.win)}>
          {!result.win ? (
            <div style={C.resultTitle(false)}>{t(result.msgKey)}</div>
          ) : (
            <>
              <div style={C.resultTitle(true)}>{t('calc.won')}</div>
              <div style={C.fanBig}>{result.fan}<span style={C.fanUnit}>{t('calc.fanUnit')}</span></div>
              {result.yaku.map((y, i) => {
                // The scoring engine emits Chinese pattern names; the English UI swaps in the English name here (see yakuText in i18n)
                const shown = yakuText(lang, y);
                return (
                  <div key={i} style={C.yakuRow}>
                    <div>
                      <div style={C.yakuName}>{shown.name}</div>
                      <div style={C.yakuDesc}>{shown.description}</div>
                    </div>
                    <div style={C.yakuFan}>+{shown.fan}</div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
    </div>
  );
}