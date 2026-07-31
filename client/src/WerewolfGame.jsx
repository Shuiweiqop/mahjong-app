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
  witch: { emoji: '🧪', name: '女巫', desc: '解药救人、毒药毒人,各一瓶' },
  hunter: { emoji: '🔫', name: '猎人', desc: '出局时可开枪带走一名玩家(被毒除外)' },
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
  // 遇害动画:天亮进入发言阶段的那一刻放一次,放完就不再重复。
  // 用 round 做键 —— 同一轮内的任何状态广播都不该重放动画。
  const [slashRound, setSlashRound] = useState(null);
  const victims = Array.isArray(state.lastNightVictim)
    ? state.lastNightVictim
    : state.lastNightVictim ? [state.lastNightVictim] : [];
  // 天亮时放一次夜晚结果动画。有人死 → 斜切;没人死 → 刀被挡下。
  // 注意"平安夜"和"被女巫救了"在前端看起来必须完全一样 —— 服务端也确实
  // 只发 lastNightVictim=null。能区分的话就等于泄露了女巫用没用解药。
  const showNightResult = state.phase === 'speech' && slashRound !== state.round;
  const showSlash = showNightResult && victims.length > 0;
  const showBlocked = showNightResult && victims.length === 0 && state.round > 0;

  // 枪响动画:从公开日志里读最后一次开枪。log 本来就全房间可见,
  // 不需要服务端为动画新加字段 —— 谁被带走了本就是既成事实。
  const log = state.log || [];
  const lastShot = [...log].reverse().find((e) => e.type === 'hunter_shot' && e.target);
  const shotKey = lastShot ? `${lastShot.playerId}->${lastShot.target}` : null;
  const [shownShot, setShownShot] = useState(null);
  const showGunshot = shotKey && shownShot !== shotKey;
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

  const phaseLabel = {
    night: '🌙 夜晚', speech: '🎤 轮流发言', day: '☀️ 投票放逐', pk: '⚔️ 平票 PK',
    witch: '🧪 女巫用药', hunter: '🔫 猎人开枪',
  }[state.phase] || state.phase;

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
            {state.myRole === 'witch' && state.potions && (
              <div style={{ fontSize: 13, marginTop: 6 }}>
                🧪 解药 {state.potions.heal ? '✅' : '❌'} · 毒药 {state.potions.poison ? '✅' : '❌'}
              </div>
            )}
            {state.myRole === 'hunter' && (
              <div style={{ fontSize: 13, marginTop: 6 }}>
                🔫 {state.hunterCanShoot ? '枪已上膛(出局时可开枪,被毒除外)' : '枪已用过'}
              </div>
            )}
              </>
            )}
          </div>

          {/* 遇害动画:天亮那一刻放一次。所有人都该看到(包括观战者和死者),
              这是公开的夜晚结果,不是分角色信息。 */}
          {showSlash && (
            <div style={{ marginBottom: 12 }}>
              {victims.map((id) => (
                <SlashReveal key={id} name={nameOf(id)}
                  // 只在观战上帝视角下显示身份。不要写成 state.roles?.[id] ——
                  // 那样一旦服务端将来在对局中下发 roles(比如为了某个新功能),
                  // 这里就会跟着把死者身份暴露给全场,而且没有任何东西会报错。
                  // 显示什么由"我有没有资格看"决定,不由"字段在不在"决定。
                  role={godRoles?.[id]}
                  onDone={() => setSlashRound(state.round)} />
              ))}
              <p style={{ textAlign: 'center', color: 'var(--danger)', fontWeight: 700 }}>
                🔪 {victims.map(nameOf).join('、')} 倒牌了
              </p>
            </div>
          )}

          {/* 平安夜:刀被挡下。文案刻意只说"无人倒牌",不区分空刀还是被救 ——
              区分的话就暴露了女巫有没有用解药。 */}
          {showBlocked && (
            <div style={{ marginBottom: 12 }}>
              <BlockedReveal onDone={() => setSlashRound(state.round)} />
              <p style={{ textAlign: 'center', color: 'var(--accent)', fontWeight: 700 }}>
                🛡️ 昨晚是平安夜
              </p>
            </div>
          )}

          {/* 枪响:开完枪后放一次。打的是既成事实,全场可见。 */}
          {showGunshot && (
            <div style={{ marginBottom: 12 }}>
              <GunshotReveal name={nameOf(lastShot.target)}
                onDone={() => setShownShot(shotKey)} />
              <p style={{ textAlign: 'center', color: 'var(--danger)', fontWeight: 700 }}>
                🔫 {nameOf(lastShot.playerId)} 开枪带走了 {nameOf(lastShot.target)}
              </p>
            </div>
          )}

          {/* 行动区。猎人的开枪要放在"已出局"判断之前 —— 他正是因为死了才要开枪。 */}
          {isSpectator ? (
            <p style={{ color: 'var(--muted)', textAlign: 'center' }}>👀 观战中,无法参与行动</p>
          ) : state.phase === 'hunter' ? (
            <HunterShot state={state} act={act} nameOf={nameOf} alivePlayers={alivePlayers} />
          ) : !iAmAlive ? (
            <p style={{ color: 'var(--muted)', textAlign: 'center' }}>你已出局,静静观战…</p>
          ) : state.phase === 'speech' ? (
            <SpeechTurn state={state} act={act} nameOf={nameOf} />
          ) : state.phase === 'witch' ? (
            <WitchActions state={state} act={act} nameOf={nameOf} alivePlayers={alivePlayers} />
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

// 夜里可能死多个人(狼刀 + 女巫毒),所以 lastNightVictim 是数组。
// 早期版本它是单个 id,直接丢给 nameOf 会得到"玩家",看不出是谁死了。
function victimNames(victim, nameOf) {
  const ids = Array.isArray(victim) ? victim : victim ? [victim] : [];
  if (!ids.length) return null;
  return `昨晚 ${ids.map(nameOf).join('、')} 遇害了`;
}

// 遇害动画:匕首斜划过牌面,牌被切成两半错开滑落。
// 纯 CSS + clip-path —— 上下两半是同一张牌渲染两遍,各自裁掉一半,
// 然后往相反方向滑走。不需要任何动画库。
//
// 尊重 prefers-reduced-motion:关掉动效的用户直接看到结果,不做切割动画。
function SlashReveal({ name, role, onDone }) {
  const [stage, setStage] = useState('idle');   // idle → slash → split → done
  useEffect(() => {
    const t1 = setTimeout(() => setStage('slash'), 200);
    const t2 = setTimeout(() => setStage('split'), 700);
    const t3 = setTimeout(() => { setStage('done'); onDone?.(); }, 2200);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [onDone]);

  if (stage === 'done') return null;
  const info = ROLE_INFO[role];

  // 牌面内容(上下半各渲染一次)
  const face = (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      width: '100%', height: '100%', gap: 6,
      background: 'var(--surface-2)', border: '2px solid var(--border)', borderRadius: 12,
    }}>
      <div style={{ fontSize: 38 }}>{info?.emoji ?? '🙂'}</div>
      <div style={{ fontWeight: 800, fontSize: 17 }}>{name}</div>
      {info && <div style={{ fontSize: 13, color: 'var(--muted)' }}>{info.name}</div>}
    </div>
  );

  const split = stage === 'split';
  const half = (which) => ({
    position: 'absolute', inset: 0,
    // 沿对角线裁切:上半保留左上,下半保留右下
    clipPath: which === 'top'
      ? 'polygon(0 0, 100% 0, 100% 38%, 0 74%)'
      : 'polygon(0 74%, 100% 38%, 100% 100%, 0 100%)',
    transform: split
      ? (which === 'top' ? 'translate(-14px,-18px) rotate(-5deg)' : 'translate(14px,20px) rotate(5deg)')
      : 'none',
    opacity: split ? 0 : 1,
    transition: 'transform 1.1s cubic-bezier(0.2,0.7,0.3,1), opacity 1.1s ease-in',
  });

  return (
    <div className="slash-wrap" style={{
      position: 'relative', width: 190, height: 150, margin: '0 auto 12px',
    }}>
      <div style={half('top')}>{face}</div>
      <div style={half('bottom')}>{face}</div>
      {/* 刀光:一道细白光沿对角线扫过 */}
      {stage !== 'idle' && (
        <div className="slash-blade" style={{
          position: 'absolute', inset: -20, pointerEvents: 'none',
          background: 'linear-gradient(108deg, transparent 44%, #fff 49%, #ffd9d9 50%, transparent 56%)',
        }} />
      )}
    </div>
  );
}

// 平安夜:刀光斜劈下来,撞上一面盾牌弹开、碎裂。
//
// 这个动画对"狼空刀"和"女巫用解药救了人"必须表现得一模一样 —— 服务端
// 本来就只发 lastNightVictim=null,前端要是能区分,就等于告诉所有人
// 女巫今晚用没用药,解药的价值直接归零。
function BlockedReveal({ onDone }) {
  const [stage, setStage] = useState('idle');   // idle → clash → done
  useEffect(() => {
    const t1 = setTimeout(() => setStage('clash'), 200);
    const t2 = setTimeout(() => { setStage('done'); onDone?.(); }, 1900);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [onDone]);

  if (stage === 'done') return null;
  const clash = stage === 'clash';

  return (
    <div style={{ position: 'relative', width: 190, height: 150, margin: '0 auto 12px' }}>
      <div className={clash ? 'block-shield' : undefined} style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
        background: 'var(--surface-2)', border: '2px solid var(--accent)', borderRadius: 12,
      }}>
        <div style={{ fontSize: 38 }}>🛡️</div>
        <div style={{ fontWeight: 800, fontSize: 16 }}>无人倒牌</div>
      </div>
      {/* 刀光斜劈下来,到中途被挡住(只扫一半就停) */}
      {clash && (
        <div className="block-blade" style={{
          position: 'absolute', inset: -20, pointerEvents: 'none',
          background: 'linear-gradient(108deg, transparent 44%, #fff 49%, #d9e6ff 50%, transparent 56%)',
        }} />
      )}
      {/* 撞击迸出的火花 */}
      {clash && <div className="block-spark" style={{
        position: 'absolute', left: '50%', top: '50%', width: 10, height: 10,
        marginLeft: -5, marginTop: -5, borderRadius: '50%',
        background: 'radial-gradient(circle, #fff 0%, #ffd76a 45%, transparent 70%)',
        pointerEvents: 'none',
      }} />}
    </div>
  );
}

// 枪响:枪口闪光 + 目标牌被击中震颤后倒下。
//
// 只在"已经开完枪"时播 —— 打的是既成事实(谁被带走了是公开信息)。
// 瞄准过程绝不播动画:那会在扣扳机前就暴露枪口指向谁。
function GunshotReveal({ name, onDone }) {
  const [stage, setStage] = useState('idle');   // idle → fire → fall → done
  useEffect(() => {
    const t1 = setTimeout(() => setStage('fire'), 150);
    const t2 = setTimeout(() => setStage('fall'), 550);
    const t3 = setTimeout(() => { setStage('done'); onDone?.(); }, 2000);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [onDone]);

  if (stage === 'done') return null;
  const fell = stage === 'fall';

  return (
    <div style={{ position: 'relative', width: 190, height: 150, margin: '0 auto 12px' }}>
      <div className={stage === 'fire' ? 'gun-hit' : undefined} style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
        background: 'var(--surface-2)', border: '2px solid var(--danger)', borderRadius: 12,
        transform: fell ? 'translateY(34px) rotate(9deg)' : 'none',
        opacity: fell ? 0 : 1,
        transition: 'transform 1.1s cubic-bezier(0.4,0,0.6,1), opacity 1.1s ease-in',
      }}>
        <div style={{ fontSize: 38 }}>🎯</div>
        <div style={{ fontWeight: 800, fontSize: 17 }}>{name}</div>
      </div>
      {/* 枪口闪光:从中心炸开的一团白光 */}
      {stage === 'fire' && (
        <div className="gun-flash" style={{
          position: 'absolute', left: '50%', top: '50%', width: 16, height: 16,
          marginLeft: -8, marginTop: -8, borderRadius: '50%', pointerEvents: 'none',
          background: 'radial-gradient(circle, #fff 0%, #ffe08a 40%, #ff8a3d 65%, transparent 75%)',
        }} />
      )}
    </div>
  );
}

// 轮流发言。一次只有一个人能说,其余人只能看 —— 这样狼没法靠刷屏
// 把预言家的报点冲走。轮到自己时用下方的聊天框发言,说完点"过"。
function SpeechTurn({ state, act, nameOf }) {
  const order = state.speechOrder || [];
  const cur = state.currentSpeaker;

  return (
    <div>
      <p style={{ marginBottom: 10, fontWeight: 700, textAlign: 'center' }}>
        {state.iAmSpeaking ? '🎤 轮到你发言了' : `🎤 ${nameOf(cur)} 正在发言`}
      </p>
      <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', marginBottom: 10 }}>
        第 {(state.spokenCount ?? 0) + 1} / {state.speechTotal} 位
      </div>

      {/* 发言顺序一览:已说过的变淡,当前的高亮 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', marginBottom: 10 }}>
        {order.map((id, i) => (
          <span key={id} style={{
            ...ui.badge, fontSize: 12,
            opacity: i < (state.spokenCount ?? 0) ? 0.4 : 1,
            background: id === cur ? 'var(--accent)' : 'var(--surface-2)',
            color: id === cur ? '#fff' : 'var(--text)',
          }}>{nameOf(id)}</span>
        ))}
      </div>

      {state.iAmSpeaking ? (
        <>
          <p style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', marginBottom: 8 }}>
            在下方聊天框发言,说完点"过"
          </p>
          <button style={{ ...ui.btnAccent, width: '100%' }}
            onClick={() => act({ type: 'pass_speech' })}>过(结束发言)</button>
        </>
      ) : (
        <WaitHint text="其他人发言中,请等待…" />
      )}
    </div>
  );
}

// 女巫用药。服务端在狼刀结算后单独开一段给她,因为她要先看到刀口才能决定。
// 刀口(state.witchVictim)只会下发给女巫本人。
function WitchActions({ state, act, nameOf, alivePlayers }) {
  const [mode, setMode] = useState(null);   // null | 'poison'(选毒药目标中)
  const victim = state.witchVictim;
  const potions = state.potions || {};
  // 首夜可自救;之后刀口是自己就不能用解药
  const selfBlocked = victim === state.myId && !state.canSelfHeal;
  const canHeal = potions.heal && victim && !selfBlocked;

  if (state.myRole !== 'witch') {
    return <p style={{ color: 'var(--muted)', textAlign: 'center' }}>🌙 天黑请闭眼,女巫行动中…</p>;
  }
  if (state.iActed) return <WaitHint text="✓ 已行动,等待天亮…" />;

  if (mode === 'poison') {
    return (
      <div>
        <p style={{ marginBottom: 10, fontWeight: 700, textAlign: 'center' }}>☠️ 选择要毒的玩家</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {alivePlayers.filter((p) => p.id !== state.myId).map((p) => (
            <button key={p.id} style={{ ...ui.btnGhost, color: 'var(--danger)' }}
              onClick={() => act({ type: 'witch', poison: p.id })}>毒死 {p.name}</button>
          ))}
        </div>
        <button style={{ ...ui.btnGhost, marginTop: 8, width: '100%' }} onClick={() => setMode(null)}>
          返回
        </button>
      </div>
    );
  }

  return (
    <div>
      <p style={{ marginBottom: 10, fontWeight: 700, textAlign: 'center' }}>
        {victim ? `🔪 今晚 ${nameOf(victim)} 倒牌` : '🌙 今晚是平安夜(无人被刀)'}
      </p>
      <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', marginBottom: 10 }}>
        解药 {potions.heal ? '✅' : '❌ 已用'} · 毒药 {potions.poison ? '✅' : '❌ 已用'}
        {selfBlocked && ' · 首夜之后不能自救'}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {canHeal && (
          <button style={{ ...ui.btnGhost, color: 'var(--accent)' }}
            onClick={() => act({ type: 'witch', heal: true })}>💊 使用解药救 {nameOf(victim)}</button>
        )}
        {potions.poison && (
          <button style={{ ...ui.btnGhost, color: 'var(--danger)' }}
            onClick={() => setMode('poison')}>☠️ 使用毒药</button>
        )}
        <button style={ui.btnGhost} onClick={() => act({ type: 'witch' })}>跳过(不用药)</button>
      </div>
    </div>
  );
}

// 猎人开枪。注意这个组件对"已出局"的猎人也要渲染 —— 他正是因为死了才开枪。
//
// 信息隔离的要点在"瞄准"这一步:猎人选目标的过程只存在于他自己的浏览器里
// (下面的 aiming 是本地 state,不经过服务端),别人看到的永远只有"猎人正在
// 选择"这一句。绝不要把瞄准中的目标发给服务端做什么"瞄准动效"—— 那等于在
// 他扣扳机之前就把枪口指给全场看,被瞄的人可以抢先发言自辩。
function HunterShot({ state, act, nameOf, alivePlayers }) {
  // 本地瞄准态:仅用于二次确认,不上报。null = 还没选
  const [aiming, setAiming] = useState(null);

  if (!state.iAmShooting) {
    return (
      <div style={{ textAlign: 'center' }}>
        <div className="hunter-wait" style={{ fontSize: 40, marginBottom: 6 }}>🔫</div>
        <p style={{ color: 'var(--muted)' }}>
          {nameOf(state.pendingHunter)} 是猎人,正在选择开枪目标…
        </p>
      </div>
    );
  }

  // 已选中目标 → 二次确认。开枪不可撤销,误点代价太大。
  if (aiming) {
    return (
      <div style={{ textAlign: 'center' }}>
        <p style={{ marginBottom: 10, fontWeight: 700 }}>🔫 确认开枪?</p>
        <div className="hunter-aim" style={{
          fontSize: 38, margin: '0 auto 10px', width: 76, height: 76, lineHeight: '76px',
          borderRadius: '50%', border: '2px solid var(--danger)',
        }}>🎯</div>
        <p style={{ marginBottom: 12 }}>
          带走 <b style={{ color: 'var(--danger)' }}>{nameOf(aiming)}</b>
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button style={{ ...ui.btnAccent, background: 'var(--danger)' }}
            onClick={() => act({ type: 'hunter_shoot', target: aiming })}>确认开枪</button>
          <button style={ui.btnGhost} onClick={() => setAiming(null)}>重新选择</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <p style={{ marginBottom: 10, fontWeight: 700, textAlign: 'center' }}>🔫 你出局了 —— 开枪带走一人</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {alivePlayers.map((p) => (
          <button key={p.id} style={{ ...ui.btnGhost, color: 'var(--danger)' }}
            onClick={() => setAiming(p.id)}>瞄准 {p.name}</button>
        ))}
        <button style={ui.btnGhost} onClick={() => act({ type: 'hunter_shoot', target: null })}>
          放弃开枪
        </button>
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
        {victimNames(state.lastNightVictim, nameOf) || '昨晚是平安夜,无人死亡'}
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
  // 发言阶段只有轮到的人能说;投票阶段(day/pk)大家自由讨论。
  const canSpeakPublic = iAmAlive && (
    state.phase === 'day' || state.phase === 'pk' ||
    (state.phase === 'speech' && state.iAmSpeaking)
  );
  // 观战者不能发言(服务端会拒);死者可发死人频道;存活者按上面的规则。
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
            : state.phase === 'night' ? '🌙 夜晚不能公开发言'
            : state.phase === 'speech' ? '🎤 轮流发言中,等待轮到你…'
            : '当前不能发言'}
        </p>
      )}
    </div>
  );
}

function WaitHint({ text }) {
  return <p style={{ color: 'var(--muted)', fontSize: 13, textAlign: 'center', marginTop: 12 }}>{text}</p>;
}
