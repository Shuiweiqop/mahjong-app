import { useEffect, useReducer, useRef, useState } from 'react';
import RoleReveal from './RoleReveal';
import { ui } from './ui';

// 狼人杀游戏界面(对局中)。
// props: state(分角色视图), act(action=>void), me{id,name}, socket(ref,用于订阅聊天事件)
// state.phase: reveal | night | day | pk | ended
//   day/pk = 讨论 + 投票(有倒计时);pk = 平票加赛(仅非候选者可投候选人之一)
const ROLE_INFO = {
  wolf: { emoji: '🐺', name: '狼人', desc: '夜晚与同伴一起猎杀一名玩家' },
  seer: { emoji: '🔮', name: '预言家', desc: '每晚查验一名玩家的身份' },
  villager: { emoji: '👤', name: '平民', desc: '白天找出并投票放逐狼人' },
};

// 倒计时:读 state.deadline(ms 时间戳),每 500ms 触发一次重渲染,剩余秒数由 deadline 现算。
// 不把秒数存进 state —— 避免在 effect 里同步 setState。剩 10s 内变红 + 脉动,制造紧迫感。
function Countdown({ deadline }) {
  const [, forceTick] = useReducer((n) => n + 1, 0);
  const active = deadline != null;
  useEffect(() => {
    if (!active) return;                     // 无 deadline 时不空转
    const t = setInterval(forceTick, 500);
    return () => clearInterval(t);
  }, [active]);
  if (!active) return null;
  const left = remain(deadline);
  const danger = left <= 10;
  return (
    <span style={{
      ...ui.badge,
      fontSize: 15, fontWeight: 800, padding: '6px 14px',
      background: danger ? 'var(--danger)' : 'var(--surface-2)',
      color: danger ? '#fff' : 'var(--text)',
      animation: danger ? 'pulse 1s ease-in-out infinite' : 'none',
    }}>
      ⏱ {left}s
    </span>
  );
}
const remain = (deadline) => deadline == null ? 0 : Math.max(0, Math.ceil((deadline - Date.now()) / 1000));

export default function WerewolfGame({ state, act, me, socket }) {
  const players = state.players || [];
  const nameOf = (id) => players.find((p) => p.id === id)?.name || '玩家';
  const role = ROLE_INFO[state.myRole] || ROLE_INFO.villager;
  // 观战者不是本局玩家:既不算存活也不算出局,不显示"你已出局"之类的玩家态提示
  const isSpectator = !!state.spectator;
  const iAmAlive = isSpectator ? null : state.alive;
  const alivePlayers = players.filter((p) => p.alive);
  // 上帝视角(房主开启)下,观战者可见每个人的角色
  const godRoles = isSpectator && state.roles ? state.roles : null;

  // ── 聊天/发言 ──(钩子必须在任何条件 return 之前)
  // 订阅 chat 事件:channel='dead' 的死人频道消息只会发到死者/观战者(服务端已按频道路由)。
  const [messages, setMessages] = useState([]);
  const chatEndRef = useRef(null);
  const membersRef = useRef(players);
  useEffect(() => { membersRef.current = players; });
  useEffect(() => {
    const s = socket?.current;
    if (!s) return;
    const nm = (id) => membersRef.current.find((p) => p.id === id)?.name || '玩家';
    const onChat = ({ playerId, text, channel }) =>
      setMessages((m) => [...m.slice(-60), { id: Math.random(), name: nm(playerId), text, channel }]);
    s.on('chat', onChat);
    return () => s.off('chat', onChat);
  }, [socket]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // 身份序幕:仅在服务端 reveal 阶段显示(此阶段夜晚尚未计时)。
  // 点"进入游戏"→ 发 ready;等所有存活玩家就绪(或宽限超时),服务端推进到 night,序幕自然消失。
  if (state.phase === 'reveal' && state.myRole) {
    return (
      <RoleReveal
        role={state.myRole}
        ready={state.iReady}
        readyCount={state.readyCount}
        readyTotal={state.readyTotal}
        onDone={() => act({ type: 'ready' })}
      />
    );
  }

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

  const phaseLabel = { night: '🌙 夜晚', day: '☀️ 白天讨论 · 投票', pk: '⚔️ 平票 PK' }[state.phase] || state.phase;

  return (
    <div>
      {/* 状态条 */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={ui.badge}>第 {state.round} 天</span>
        <span style={ui.badge}>{phaseLabel}</span>
        <Countdown deadline={state.deadline} />
        {isSpectator ? (
          <span style={ui.badge}>👀 观战{state.spectatorGodView ? ' · 上帝视角' : ''}</span>
        ) : (
          <span style={{ ...ui.badge, background: iAmAlive ? 'var(--surface-2)' : 'var(--danger)' }}>
            {role.emoji} 你是{role.name}{iAmAlive ? '' : ' · 已出局'}
          </span>
        )}
      </div>

      <div className="game-layout" style={{ '--side': '220px' }}>
        {/* 左:主区(角色行动 / 讨论 / 投票);窄屏下降级为单栏,侧栏落到下方 */}
        <div style={ui.card}>
          {/* 我的身份卡(观战者没有身份,显示观战说明) */}
          <div style={{ marginBottom: 14, padding: 12, borderRadius: 10, background: 'var(--surface-2)' }}>
            {isSpectator ? (
              <>
                <div style={{ fontWeight: 800, marginBottom: 4 }}>👀 观战中</div>
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                  你不参与本局{state.spectatorGodView ? ',房主已开启上帝视角,右侧可见所有身份' : ',仅可见公开信息'}
                </div>
              </>
            ) : (
              <>
            <div style={{ fontWeight: 800, marginBottom: 4 }}>{role.emoji} {role.name}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>{role.desc}</div>
            {state.myRole === 'wolf' && state.wolfTeammates && (
              <div style={{ fontSize: 13, marginTop: 6, color: 'var(--danger)' }}>
                {state.wolfTeammates.length > 0
                  ? `🐺 狼队友:${state.wolfTeammates.map(nameOf).join('、')}`
                  : '🐺 你是唯一的狼'}
              </div>
            )}
            {state.myRole === 'seer' && state.seerResults && Object.keys(state.seerResults).length > 0 && (
              <div style={{ fontSize: 13, marginTop: 6 }}>
                🔮 查验记录:{Object.entries(state.seerResults).map(([id, r]) =>
                  `${nameOf(id)}=${r === 'wolf' ? '狼人❌' : '好人✅'}`).join('、')}
              </div>
            )}
              </>
            )}
          </div>

          {/* 行动区 */}
          {isSpectator ? (
            <p style={{ color: 'var(--muted)', textAlign: 'center' }}>👀 观战中,无法参与行动</p>
          ) : !iAmAlive ? (
            <p style={{ color: 'var(--muted)', textAlign: 'center' }}>你已出局,静静观战…</p>
          ) : state.phase === 'night' ? (
            <NightActions state={state} act={act} me={me} alivePlayers={alivePlayers} />
          ) : state.phase === 'day' ? (
            <DayVote state={state} act={act} me={me} alivePlayers={alivePlayers} nameOf={nameOf} />
          ) : state.phase === 'pk' ? (
            <PkVote state={state} act={act} nameOf={nameOf} />
          ) : null}

          {/* 讨论区:存活者白天/PK 可公开发言;死者/观战者走死人频道。夜晚存活者禁言。 */}
          <ChatPanel
            state={state} act={act} messages={messages} chatEndRef={chatEndRef}
            isSpectator={isSpectator} iAmAlive={iAmAlive}
          />
        </div>

        {/* 右:玩家列表 */}
        <div style={{ ...ui.card, marginBottom: 0, padding: 12 }}>
          <label style={ui.label}>玩家 ({alivePlayers.length} 存活)</label>
          {players.map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0',
              color: p.alive ? 'var(--text)' : 'var(--muted)', textDecoration: p.alive ? 'none' : 'line-through' }}>
              <span>{p.alive ? '🙂' : '💀'} {p.name}{p.id === me.id ? ' (你)' : ''}</span>
              {godRoles?.[p.id] && (
                <span style={{ color: 'var(--accent)', fontSize: 13 }}>
                  {ROLE_INFO[godRoles[p.id]]?.emoji} {ROLE_INFO[godRoles[p.id]]?.name}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// 夜晚行动:狼人选刀、预言家查验。行动后显示等待态(仍可改选,等所有人行动完或超时天亮)。
function NightActions({ state, act, me, alivePlayers }) {
  const targets = alivePlayers.filter((p) => p.id !== me.id);
  const acted = state.iActed;

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
        {acted && <WaitHint text="✓ 已出刀,等待其他人行动…" />}
      </div>
    );
  }
  if (state.myRole === 'seer') {
    // 与狼人不同:查验每夜只有一次,不能改。已查验后禁用按钮 ——
    // 否则玩家会一直点,只收到服务端的"今晚已经查验过了"弹窗。
    return (
      <div>
        <p style={{ marginBottom: 10, fontWeight: 700, textAlign: 'center' }}>
          {acted ? '🔮 今晚已查验(每夜限一次)' : '🔮 查验一名玩家的身份'}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {targets.map((p) => (
            <button key={p.id} disabled={acted}
              style={{ ...ui.btnGhost, ...(acted ? { opacity: 0.45, cursor: 'not-allowed' } : null) }}
              onClick={() => act({ type: 'seer_check', target: p.id })}>查验 {p.name}</button>
          ))}
        </div>
        {acted && <WaitHint text="✓ 已查验,等待其他人行动…" />}
      </div>
    );
  }
  return <p style={{ color: 'var(--muted)', textAlign: 'center' }}>🌙 天黑请闭眼,等待天亮…</p>;
}

// 白天:讨论 + 投票(同阶段)。列表可点,随时改票;高亮当前票;倒计时到点由服务端结算。
function DayVote({ state, act, me, alivePlayers, nameOf }) {
  const myVote = state.myVote;               // 当前票:玩家 id、或 null(弃票)、或 undefined(未投)
  const voted = state.iVoted;
  const candidates = alivePlayers.filter((p) => p.id !== me.id);
  return (
    <div>
      <p style={{ marginBottom: 6, textAlign: 'center' }}>
        {state.lastNightVictim
          ? `昨晚 ${nameOf(state.lastNightVictim)} 遇害了` : '昨晚是平安夜,无人死亡'}
      </p>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12, textAlign: 'center' }}>
        讨论并投票放逐一名玩家 · 时间内可改票 · 全员投完后加速结算
        {state.cfg?.tiePk ? '(平票进入 PK 加赛)' : '(平票无人出局)'}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {candidates.map((p) => {
          const picked = myVote === p.id;
          return (
            <button key={p.id}
              style={{ ...ui.btnGhost, ...(picked ? { borderColor: 'var(--accent)', color: 'var(--accent)', fontWeight: 800 } : {}) }}
              onClick={() => act({ type: 'vote', target: p.id })}>
              {picked ? '✓ ' : ''}投 {p.name}
            </button>
          );
        })}
        <button
          style={{ ...ui.btnGhost, color: 'var(--muted)', ...(voted && myVote == null ? { borderColor: 'var(--accent)' } : {}) }}
          onClick={() => act({ type: 'vote', target: null })}>
          {voted && myVote == null ? '✓ ' : ''}弃票
        </button>
      </div>
      {!voted && <WaitHint text="你还没投票 — 到点未投将视为弃票" />}
      {state.dayAllVoted && (
        <p style={{ color: 'var(--accent)', fontSize: 13, marginTop: 10, textAlign: 'center' }}>
          ✓ 全员已投,即将结算 · 仍可改票
        </p>
      )}
    </div>
  );
}

// PK 加赛:平票者成为候选。候选人本轮不投票(等裁决);其余存活玩家只能在候选人之间二选一(或弃票)。
function PkVote({ state, act, nameOf }) {
  const cands = state.pkCandidates || [];
  const iAmCand = state.iAmPkCandidate;
  const myVote = state.myVote;
  const voted = state.iVoted;
  return (
    <div>
      <p style={{ marginBottom: 6, textAlign: 'center', fontWeight: 800, color: 'var(--danger)' }}>
        ⚔️ 平票 PK:{cands.map(nameOf).join(' vs ')}
      </p>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12, textAlign: 'center' }}>
        {iAmCand
          ? '你是 PK 候选人 —— 为自己辩护,由其余玩家裁决'
          : '在候选人之间二选一 · 再次平票则无人出局'}
      </p>
      {iAmCand ? (
        <WaitHint text="⚔️ 等待其余玩家投票裁决…" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {cands.map((id) => {
            const picked = myVote === id;
            return (
              <button key={id}
                style={{ ...ui.btnGhost, ...(picked ? { borderColor: 'var(--accent)', color: 'var(--accent)', fontWeight: 800 } : {}) }}
                onClick={() => act({ type: 'pk_vote', target: id })}>
                {picked ? '✓ ' : ''}投 {nameOf(id)}
              </button>
            );
          })}
          <button
            style={{ ...ui.btnGhost, color: 'var(--muted)', ...(voted && myVote == null ? { borderColor: 'var(--accent)' } : {}) }}
            onClick={() => act({ type: 'pk_vote', target: null })}>
            {voted && myVote == null ? '✓ ' : ''}弃票
          </button>
        </div>
      )}
      {state.dayAllVoted && (
        <p style={{ color: 'var(--accent)', fontSize: 13, marginTop: 10, textAlign: 'center' }}>
          ✓ 全员已投,即将裁决 · 仍可改票
        </p>
      )}
    </div>
  );
}

// 讨论区。存活者:白天/PK 可公开发言(夜晚禁言);死者/观战者:走死人频道(仅死者+观战者可见)。
// 发言权限与服务端一致 —— 服务端才是权威,这里只是不给不能发言的人显示输入框。
function ChatPanel({ state, act, messages, chatEndRef, isSpectator, iAmAlive }) {
  const [text, setText] = useState('');
  const dead = !isSpectator && iAmAlive === false;
  const canSpeakPublic = iAmAlive && (state.phase === 'day' || state.phase === 'pk');
  // 观战者不能发言(服务端会拒);死者可发死人频道;存活者仅白天/PK 可发。
  const canSend = !isSpectator && (dead || canSpeakPublic);
  const send = () => {
    const t = text.trim();
    if (!t) return;
    act({ type: 'chat', text: t });
    setText('');
  };
  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <label style={ui.label}>
        💬 讨论{dead ? ' · 死人频道(存活玩家看不到)' : ''}
      </label>
      <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column',
                    gap: 4, fontSize: 14, marginBottom: 8 }}>
        {messages.length === 0 && (
          <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>还没有人发言…</p>
        )}
        {messages.map((m) => (
          <div key={m.id} style={{ color: m.channel === 'dead' ? 'var(--muted)' : 'var(--text)' }}>
            {m.channel === 'dead' && '💀 '}
            <b>{m.name}</b>:{m.text}
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>
      {canSend ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            style={{ ...ui.input, marginBottom: 0, flex: 1 }}
            value={text} maxLength={300}
            placeholder={dead ? '对死者说…' : '发言讨论…'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          />
          <button style={ui.btnAccent} onClick={send}>发送</button>
        </div>
      ) : (
        <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>
          {isSpectator ? '观战中,仅可查看讨论'
            : state.phase === 'night' ? '🌙 夜晚不能公开发言' : '当前不能发言'}
        </p>
      )}
    </div>
  );
}

function WaitHint({ text }) {
  return <p style={{ color: 'var(--muted)', fontSize: 13, textAlign: 'center', marginTop: 12 }}>{text}</p>;
}
