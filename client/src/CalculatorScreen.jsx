import { useState, useCallback } from 'react';
import { parseHand, analyzeHand, calcHK, calcGB, calcTenpai } from './calculator/index.js';

// ── Tile helpers ─────────────────────────────────────────
const SUITS_CONFIG = [
  { key: 'm', label: '万', nums: [1,2,3,4,5,6,7,8,9] },
  { key: 'p', label: '饼', nums: [1,2,3,4,5,6,7,8,9] },
  { key: 's', label: '条', nums: [1,2,3,4,5,6,7,8,9] },
  { key: 'z', label: '字', nums: [1,2,3,4,5,6,7] },
];

const WIND_LABELS   = ['','东','南','西','北'];
const DRAGON_LABELS = ['','','','','','中','发','白'];

function tileDisplay(suit, num) {
  if (suit === 'z') return num <= 4 ? WIND_LABELS[num] : DRAGON_LABELS[num];
  return String(num);
}
function tileSuitSuffix(suit) {
  return { m: '万', p: '饼', s: '条', z: '' }[suit];
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

  // 听牌
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

  // 结果
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
function TilePicker({ hand, onAdd }) {
  const used = {};
  for (const t of hand) {
    const k = `${t.suit}${t.num}`;
    used[k] = (used[k] || 0) + 1;
  }
  return (
    <div>
      {SUITS_CONFIG.map(suit => (
        <div key={suit.key} style={C.pickerSection}>
          <span style={C.pickerLabel}>{suit.label}</span>
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
                  <span style={C.pickerTileNum(suit.key)}>{tileDisplay(suit.key, num)}</span>
                  <span style={C.pickerTileSuit(suit.key)}>{tileSuitSuffix(suit.key)}</span>
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
function TenpaiBox({ tiles }) {
  return (
    <div style={C.tenpaiBox}>
      <div style={C.tenpaiTitle}>🀄 听牌 — 还差一张</div>
      {tiles.length === 0 ? (
        <div style={C.tenpaiNone}>未听牌，继续摸牌</div>
      ) : (
        <div style={C.tenpaiGrid}>
          {tiles.map((t, i) => (
            <div key={i} style={C.tenpaiTile(t.suit)}>
              <span style={C.handTileNum(t.suit)}>{tileDisplay(t.suit, t.num)}</span>
              <span style={C.handTileSuit(t.suit)}>{tileSuitSuffix(t.suit)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────
export default function CalculatorScreen({ onBack }) {
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
        setError(`需要 13 或 14 张牌，当前 ${hand.length} 张`);
        return;
      }
      tiles = hand;
    } else {
      const parsed = parseHand(textInput);
      if (parsed.error) { setError(parsed.error); return; }
      tiles = parsed.tiles;
    }

    // ── 13张：听牌提示 ───────────────────────────────────
    if (tiles.length === 13) {
      setLoading(true);
      setTimeout(() => {
        const waiting = calcTenpai(tiles);
        setTenpai(waiting);
        setLoading(false);
      }, 0);
      return;
    }

    // ── 14张：番型计算 ───────────────────────────────────
    const { win, decompositions } = analyzeHand(tiles);
    if (!win) { setResult({ win: false, msg: '未和牌 — 请检查手牌' }); return; }

    const calc = rule === 'hk' ? calcHK : calcGB;
    const { fan, yaku, belowMinimum } = calc(decompositions, context);

    if (rule === 'gb' && (belowMinimum || fan === 0)) {
      setResult({ win: false, msg: '和牌但未达 8 番起和（国标规则）' });
      return;
    }
    setResult({ win: true, fan, yaku });
  }, [mode, rule, hand, textInput, context]);

  const buttonLabel = () => {
    const count = displayHand.length;
    if (count === 13) return '检查听牌';
    if (count === 14) return '计算番数';
    return `计算 / 听牌`;
  };

  return (
    <div style={C.wrap}>
      {onBack && <button style={C.backBtn} onClick={onBack}>← 返回</button>}

      <h2 style={C.title}>番型计算器</h2>
      <p style={C.sub}>FAN CALCULATOR · TENPAI CHECK</p>

      {/* Rule selector */}
      <div style={C.ruleLabel}>规则</div>
      <div style={C.tabs}>
        <button style={C.tab(rule === 'hk')} onClick={() => { setRule('hk'); setResult(null); setTenpai(null); }}>
          🇭🇰 香港
        </button>
        <button style={C.tab(rule === 'gb')} onClick={() => { setRule('gb'); setResult(null); setTenpai(null); }}>
          🇨🇳 国标
        </button>
      </div>

      {/* Input mode */}
      <div style={C.ruleLabel}>输入方式</div>
      <div style={C.tabs}>
        <button style={C.tab(mode === 'pick')} onClick={() => { setMode('pick'); setResult(null); setTenpai(null); }}>
          点击选牌
        </button>
        <button style={C.tab(mode === 'text')} onClick={() => { setMode('text'); setResult(null); setTenpai(null); }}>
          文字输入
        </button>
      </div>

      {/* Hand display */}
      <div style={C.handArea}>
  <span style={C.handCount}>{displayHand.length} / 14</span>
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
    {displayHand.length === 0 ? (
      <span style={C.handEmpty}>
        {mode === 'pick' ? '13张=听牌检查，14张=计算番数' : '输入牌型预览'}
      </span>
    ) : (
      displayHand.map((t, i) => (
        <div key={i} style={C.handTile(t.suit)}
          onClick={mode === 'pick' ? () => removeFromHand(i) : undefined}
          title={mode === 'pick' ? '点击移除' : ''}
        >
          <span style={C.handTileNum(t.suit)}>{tileDisplay(t.suit, t.num)}</span>
          <span style={C.handTileSuit(t.suit)}>{tileSuitSuffix(t.suit)}</span>
        </div>
      ))
    )}
  </div>
</div>  

      {/* Input */}
      {mode === 'pick' ? (
        <TilePicker hand={hand} onAdd={t => { setHand(h => [...h, t]); setResult(null); setTenpai(null); }} />
      ) : (
        <>
          <input style={C.textInput} value={textInput}
            onChange={e => { setTextInput(e.target.value); setResult(null); setTenpai(null); }}
            placeholder="13张听牌 / 14张算番，例：123m456p789s东东东中"
          />
          <div style={C.hint}>
            格式：数字 + 花色（m万 p饼 s条 z字）<br />
            字牌：1东 2南 3西 4北 5中 6发 7白<br />
            例：<span style={{ color: 'var(--gold)' }}>123m456p789s1155z</span>（14张算番）<br />
            例：<span style={{ color: 'var(--gold)' }}>123m456p789s155z</span>（13张听牌）
          </div>
        </>
      )}

      {/* Context (only relevant for 14-tile calculation) */}
      <div style={{ marginTop: 12 }}>
        <div style={C.contextLabel}>情境（14张时有效）</div>
        <div style={C.contextRow}>
          <button style={C.toggle(context.selfDraw)} onClick={() => toggleCtx('selfDraw')}>自摸</button>
          <button style={C.toggle(context.hasOpen)}  onClick={() => toggleCtx('hasOpen')}>有副露</button>
        </div>
      </div>

      {/* Actions */}
      <div style={C.actionRow}>
        <button style={C.calcBtn} onClick={handleCalculate} disabled={loading}>
          {loading ? '计算中...' : buttonLabel()}
        </button>
        <button style={C.clearBtn} onClick={clearAll}>清空</button>
      </div>

      {/* Error */}
      {error && <div style={C.errorBox}>{error}</div>}

      {/* Tenpai result */}
      {tenpai !== null && <TenpaiBox tiles={tenpai} />}

      {/* Fan result */}
      {result && (
        <div style={C.resultBox(result.win)}>
          {!result.win ? (
            <div style={C.resultTitle(false)}>{result.msg}</div>
          ) : (
            <>
              <div style={C.resultTitle(true)}>和牌！</div>
              <div style={C.fanBig}>{result.fan}<span style={C.fanUnit}>番</span></div>
              {result.yaku.map((y, i) => (
                <div key={i} style={C.yakuRow}>
                  <div>
                    <div style={C.yakuName}>{y.name}</div>
                    <div style={C.yakuDesc}>{y.description}</div>
                  </div>
                  <div style={C.yakuFan}>+{y.fan}</div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}