import { ui } from './ui';

// 大厅游戏设置面板。
// - 房主:可修改,改动通过 onChange(config) 上报(emit set_config)
// - 非房主:只读展示当前设置
// props: lobby(含 config, configSchema), isHost, onChange
export default function LobbySettings({ lobby, isHost, onChange }) {
  const schema = lobby?.configSchema;
  if (!schema) return null;
  const cfg = lobby?.config || {};

  // 通用设置面板:按 configSchema 的 type 渲染,不认识具体游戏。
  //   type:'toggle'  → 开关
  //   type:'options' → 一排可选值按钮(阶段时长等)
  // 游戏模块加新配置项只改 configSchema,这里不用动。
  // 你画我猜的专属项(词库/自定义词)仍走下方定制布局 —— 用 drawSeconds 区分。
  const genericKeys = Object.keys(schema)
    .filter((k) => schema[k]?.type === 'toggle' || schema[k]?.type === 'options');
  if (genericKeys.length && !schema.drawSeconds) {
    return (
      <div style={ui.card}>
        <label style={ui.label}>游戏设置{!isHost && '(房主可改)'}</label>
        {genericKeys.map((k) => {
          const item = schema[k];
          const val = cfg[k] ?? item.default;

          if (item.type === 'toggle') {
            return (
              <label key={k} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0',
                                       cursor: isHost ? 'pointer' : 'default' }}>
                <input type="checkbox" checked={!!val} disabled={!isHost} style={{ marginTop: 3 }}
                  onChange={(e) => onChange({ ...cfg, [k]: e.target.checked })} />
                <span>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{item.label || k}</div>
                  {item.hint && <div style={{ color: 'var(--muted)', fontSize: 12 }}>{item.hint}</div>}
                </span>
              </label>
            );
          }

          return (
            <div key={k} style={{ padding: '8px 0' }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{item.label || k}</div>
              {item.hint && (
                <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 6 }}>{item.hint}</div>
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
