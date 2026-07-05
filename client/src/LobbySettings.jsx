import { ui } from './ui';

// 大厅游戏设置面板。
// - 房主:可修改,改动通过 onChange(config) 上报(emit set_config)
// - 非房主:只读展示当前设置
// props: lobby(含 config, configSchema), isHost, onChange
export default function LobbySettings({ lobby, isHost, onChange }) {
  const schema = lobby?.configSchema;
  if (!schema) return null;
  const cfg = lobby?.config || {};

  const drawSeconds = cfg.drawSeconds ?? schema.drawSeconds.default;
  const roundsPerPlayer = cfg.roundsPerPlayer ?? schema.roundsPerPlayer.default;
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
      <label style={ui.label}>游戏设置{!isHost && '(房主可改)'}</label>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, marginBottom: 6 }}>每人画几轮</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {schema.roundsPerPlayer.options.map((n) =>
            pill(roundsPerPlayer === n, () => set({ roundsPerPlayer: n }), `${n} 轮`, n))}
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, marginBottom: 6 }}>每轮作画时间</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {schema.drawSeconds.options.map((s) =>
            pill(drawSeconds === s, () => set({ drawSeconds: s }), `${s}s`, s))}
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, marginBottom: 6 }}>
          词库分类 <span style={{ color: 'var(--muted)', fontSize: 12 }}>(不选=全部)</span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {schema.categories.map((c) => {
            const on = categories.includes(c);
            return pill(on, () => {
              const next = on ? categories.filter((x) => x !== c) : [...categories, c];
              set({ categories: next });
            }, c, c);
          })}
        </div>
      </div>

      <div>
        <div style={{ fontSize: 13, marginBottom: 6 }}>
          自定义词库 <span style={{ color: 'var(--muted)', fontSize: 12 }}>(每行/逗号一个词;填了则只用这些词)</span>
        </div>
        {isHost ? (
          <textarea
            style={{ ...ui.input, minHeight: 70, resize: 'vertical', marginBottom: 0, fontFamily: 'inherit' }}
            placeholder="例:生日蛋糕, 气球, 蜡烛&#10;(留空则用上面的分类词库)"
            defaultValue={(cfg.customWords || []).join(', ')}
            onBlur={(e) => {
              const words = e.target.value.split(/[,，\n]/).map((w) => w.trim()).filter(Boolean);
              set({ customWords: words });
            }}
          />
        ) : (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>
            {(cfg.customWords || []).length ? `已设 ${cfg.customWords.length} 个自定义词` : '(使用分类词库)'}
          </p>
        )}
      </div>
    </div>
  );
}
