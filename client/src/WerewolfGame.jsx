import { ui } from './ui';

// 狼人杀游戏界面(对局中)。
// props: state(分角色视图), act(action=>void), me{id,name}, messages
// state.phase: night | day | vote | ended
const ROLE_INFO = {
  wolf: { emoji: '🐺', name: '狼人', desc: '夜晚与同伴一起猎杀一名玩家' },
  seer: { emoji: '🔮', name: '预言家', desc: '每晚查验一名玩家的身份' },
  villager: { emoji: '👤', name: '平民', desc: '白天找出并投票放逐狼人' },
};

export default function WerewolfGame({ state, act, me }) {
  const players = state.players || [];
  const nameOf = (id) => players.find((p) => p.id === id)?.name || '玩家';
  const role = ROLE_INFO[state.myRole] || ROLE_INFO.villager;
  const iAmAlive = state.alive;
  const alivePlayers = players.filter((p) => p.alive);

  // 结束
  if (state.phase === 'ended') {
    return (
      <div>
        <div style={{ ...ui.card, textAlign: 'center' }}>
          <h2 style={{ marginBottom: 8 }}>
            {state.winner === 'wolf' ? '🐺 狼人阵营胜利' : '🏡 好人阵营胜利'}
          </h2>
        </div>
        <div style={ui.card}>
          <label style={ui.label}>身份公开</label>
          {players.map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
              <span>{p.name}{p.id === me.id ? ' (你)' : ''}</span>
              <span>{ROLE_INFO[state.roles?.[p.id]]?.emoji} {ROLE_INFO[state.roles?.[p.id]]?.name}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const phaseLabel = { night: '🌙 夜晚', day: '☀️ 白天讨论', vote: '🗳️ 投票放逐' }[state.phase] || state.phase;

  return (
    <div>
      {/* 状态条 */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={ui.badge}>第 {state.round} 天</span>
        <span style={ui.badge}>{phaseLabel}</span>
        <span style={{ ...ui.badge, background: iAmAlive ? 'var(--surface-2)' : 'var(--danger)' }}>
          {role.emoji} 你是{role.name}{iAmAlive ? '' : ' · 已出局'}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 220px', gap: 14 }}>
        {/* 左:主区(角色行动 / 讨论 / 投票) */}
        <div style={ui.card}>
          {/* 我的身份卡 */}
          <div style={{ marginBottom: 14, padding: 12, borderRadius: 10, background: 'var(--surface-2)' }}>
            <div style={{ fontWeight: 800, marginBottom: 4 }}>{role.emoji} {role.name}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>{role.desc}</div>
            {state.myRole === 'wolf' && state.wolfTeammates && (
              <div style={{ fontSize: 13, marginTop: 6, color: 'var(--danger)' }}>
                🐺 狼队友:{state.wolfTeammates.map(nameOf).join('、')}
              </div>
            )}
            {state.myRole === 'seer' && state.seerResults && Object.keys(state.seerResults).length > 0 && (
              <div style={{ fontSize: 13, marginTop: 6 }}>
                🔮 查验记录:{Object.entries(state.seerResults).map(([id, r]) =>
                  `${nameOf(id)}=${r === 'wolf' ? '狼人❌' : '好人✅'}`).join('、')}
              </div>
            )}
          </div>

          {/* 行动区 */}
          {!iAmAlive ? (
            <p style={{ color: 'var(--muted)', textAlign: 'center' }}>你已出局,静静观战…</p>
          ) : state.phase === 'night' ? (
            <NightActions state={state} act={act} me={me} alivePlayers={alivePlayers} />
          ) : state.phase === 'day' ? (
            <div style={{ textAlign: 'center' }}>
              <p style={{ marginBottom: 10 }}>
                {state.lastNightVictim
                  ? `昨晚 ${nameOf(state.lastNightVictim)} 遇害了` : '昨晚是平安夜,无人死亡'}
              </p>
              <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>讨论一下,谁是狼人?</p>
              <button style={ui.btnAccent} onClick={() => act({ type: 'vote', target: null })}>
                进入投票 →
              </button>
            </div>
          ) : state.phase === 'vote' ? (
            <div>
              <p style={{ marginBottom: 10, fontWeight: 700, textAlign: 'center' }}>投票放逐一名玩家</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {alivePlayers.filter((p) => p.id !== me.id).map((p) => (
                  <button key={p.id} style={{ ...ui.btnGhost }}
                    onClick={() => act({ type: 'vote', target: p.id })}>投 {p.name}</button>
                ))}
                <button style={{ ...ui.btnGhost, color: 'var(--muted)' }}
                  onClick={() => act({ type: 'vote', target: null })}>弃票</button>
              </div>
            </div>
          ) : null}
        </div>

        {/* 右:玩家列表 */}
        <div style={{ ...ui.card, marginBottom: 0, padding: 12 }}>
          <label style={ui.label}>玩家 ({alivePlayers.length} 存活)</label>
          {players.map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0',
              color: p.alive ? 'var(--text)' : 'var(--muted)', textDecoration: p.alive ? 'none' : 'line-through' }}>
              <span>{p.alive ? '🙂' : '💀'} {p.name}{p.id === me.id ? ' (你)' : ''}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// 夜晚行动:狼人选刀、预言家查验
function NightActions({ state, act, me, alivePlayers }) {
  const targets = alivePlayers.filter((p) => p.id !== me.id);
  if (state.myRole === 'wolf') {
    return (
      <div>
        <p style={{ marginBottom: 10, fontWeight: 700, textAlign: 'center' }}>🐺 选择今晚猎杀的目标</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {targets.map((p) => (
            <button key={p.id} style={{ ...ui.btnGhost, color: 'var(--danger)' }}
              onClick={() => act({ type: 'wolf_kill', target: p.id })}>猎杀 {p.name}</button>
          ))}
        </div>
      </div>
    );
  }
  if (state.myRole === 'seer') {
    return (
      <div>
        <p style={{ marginBottom: 10, fontWeight: 700, textAlign: 'center' }}>🔮 查验一名玩家的身份</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {targets.map((p) => (
            <button key={p.id} style={ui.btnGhost}
              onClick={() => act({ type: 'seer_check', target: p.id })}>查验 {p.name}</button>
          ))}
        </div>
      </div>
    );
  }
  return <p style={{ color: 'var(--muted)', textAlign: 'center' }}>🌙 天黑请闭眼,等待天亮…</p>;
}
