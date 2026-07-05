# Playground — 多人实时游戏平台 · 环境搭建指南

一个可扩展的多人实时游戏平台。已内置两个游戏:
- **你画我猜** — 实时画布同步、词库/回合可配、猜词计分。
- **狼人杀** — 多阶段状态机(夜/昼/投票)、分角色信息隔离(狼见队友、预言家见查验、平民见公开)。

均为**服务端权威**。房主可在大厅配置游戏(回合数/时长/词库/自定义词)、踢人、转移房主。
另附一个可选**麻将番型计算器**工具页(算法演示)。

架构支持插入更多游戏 —— 新增游戏 = 一个后端模块 + 一个前端视图组件 + 注册表一行。

---

## 技术栈

| 层 | 技术 | 部署平台(线上) |
|----|------|--------------|
| 前端 | React 19 + Vite | **Vercel** |
| 后端 | Node.js + Express + **Socket.io** | **Render** |
| 数据库 | PostgreSQL | **Supabase** |
| 认证 | JWT(登录) + 访客模式 | — |

**架构接缝**:通用层(大厅/房间/实时/认证) + 可插拔游戏模块接口。
每个游戏(前后端各)实现统一接口:
- 后端模块:`createInitialState(players, config)` / `applyAction(state, action, playerId)`
  / `serializeStateFor(state, playerId)`(分玩家视图,信息隔离) / `isGameOver(state)`,
  可选 `configSchema`(房主设置项)。在 `server/games/registry.js` 注册。
- 前端视图组件:接收 `state / act / me / socket`,在 `client/src/GameRoom.jsx`
  的 `GAME_VIEWS` 注册一行(按 `gameId` 分发)。

```
mahjong-app/
├── client/                   前端(Vite + React)
│   └── src/
│       ├── App.jsx           顶层:认证→大厅→房间 + socket 连接
│       ├── AuthScreen.jsx    登录/注册/访客
│       ├── Lobby.jsx         选游戏 + 创建/加入房间 + 麻将工具页入口
│       ├── LobbySettings.jsx 房主大厅设置面板(回合/时长/词库/自定义词)
│       ├── GameRoom.jsx      房间路由器:通用大厅 + 按 gameId 分发对局界面
│       ├── DrawGuessGame.jsx 你画我猜对局界面(画布/猜词/计分/计时)
│       ├── DrawCanvas.jsx    Canvas 画笔 + 实时笔画批量同步
│       ├── WerewolfGame.jsx  狼人杀对局界面(角色卡/夜行动/投票/揭晓)
│       ├── CalculatorScreen.jsx  麻将番型计算器(可选工具页)
│       ├── calculator/       麻将算法(纯逻辑:解析/分解/番型/听牌)
│       └── config.js         读 VITE_API_BASE(后端地址)
└── server/                   后端(Express + Socket.io)
    ├── server.js             入口:REST(auth/games) + Socket.io(房间/对局/set_config/kick)
    ├── db.js                 存储层:有 DATABASE_URL 用 Postgres,否则内存降级
    ├── rooms.js              房间管理(内存):创建/加入/离开/踢人/房主转移/配置
    ├── schema.sql            Postgres 建表脚本
    ├── routes/auth.js        注册/登录/me
    └── games/
        ├── registry.js       游戏注册表
        ├── drawguess/        你画我猜模块(逻辑 + 词库 + 房主配置)
        └── werewolf/         狼人杀模块(角色/阶段状态机/信息隔离/胜负)
```

---

## 一、本地开发(零数据库,最快)

后端不设 `DATABASE_URL` 时自动用**内存存储**,本地开发无需装任何数据库。

**前置**:Node.js 18+(项目在 v22 开发)。

```bash
# 1. 装依赖
cd server && npm install
cd ../client && npm install

# 2. 启动后端(终端 1)
cd server && npm start          # → http://localhost:3001
#   看到 "📦 无 DATABASE_URL,使用内存存储" + "🎮 ...运行于" 即成功

# 3. 启动前端(终端 2)
cd client && npm run dev        # → http://localhost:5173
```

**试玩**:浏览器开 `http://localhost:5173` → 访客进入 → 选游戏创建房间;
再开**无痕窗口**同地址 → 用房间码加入 → 房主开始。
- 你画我猜:2 人起,选词/画/猜。
- 狼人杀:4 人起(需多开几个无痕窗口),夜晚行动 → 白天投票。

> 前端本地默认连 `http://localhost:3001`(见 `client/.env.development`)。

---

## 二、云端部署(免费:Supabase + Render + Vercel)

### 1. Supabase(数据库)
1. https://supabase.com → New project(**记住数据库密码**)。
2. **SQL Editor** → 粘贴 `server/schema.sql` 全部 → Run(建 3 张表)。
   - 弹出 RLS 提示选 **Run without RLS**(本平台仅后端用连接串访问,不用 RLS)。
3. 顶部 **Connect** → **Direct** → 选 **Session pooler** → 复制连接串(URI):
   ```
   postgresql://postgres.<项目ref>:<密码>@aws-0-<区域>.pooler.supabase.com:5432/postgres
   ```
   把 `<密码>` 换成你的数据库密码(**不要方括号**)。这就是 `DATABASE_URL`。

### 2. Render(后端)
1. https://render.com → 连 GitHub → New **Web Service** → 选本仓库(分支 `main`)。
2. 配置:
   - **Root Directory**: `server`
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Instance Type: **Free**
3. 环境变量(见下表)。
4. 部署,记下后端地址,如 `https://xxx.onrender.com`。
5. 验证:浏览器开 `https://xxx.onrender.com/api/health` → `{"ok":true}`。

> 免费实例闲置会休眠,首次访问需 ~30-50s 唤醒。可用 UptimeRobot 每 5 分钟 ping
> `/api/health` 保活。

### 3. Vercel(前端)
1. https://vercel.com → 连 GitHub → Import 本仓库(分支 `main`)。
2. 配置:
   - **Root Directory**: `client`
   - Framework: Vite(自动识别)
   - 环境变量:`VITE_API_BASE` = Render 后端地址(**结尾无斜杠**)。
3. Deploy,拿到前端地址,如 `https://xxx.vercel.app`。
4. **回 Render**,把 `CLIENT_ORIGIN` 设为该 Vercel 地址,自动重新部署(收紧 CORS)。

---

## 三、环境变量

### 后端(Render)
| 变量 | 说明 | 示例 |
|------|------|------|
| `DATABASE_URL` | Supabase 连接串(含密码)。**留空则用内存存储** | `postgresql://postgres.xxx:pwd@...pooler.supabase.com:5432/postgres` |
| `JWT_SECRET` | JWT 签名密钥,长随机串 | Render 可用 Generate 自动生成 |
| `CLIENT_ORIGIN` | 允许的前端来源(逗号分隔)。**留空则放开** | `https://xxx.vercel.app` |
| `PORT` | 监听端口(Render 自动注入,本地默认 3001) | `3001` |

### 前端(Vercel / 本地 client/.env.development)
| 变量 | 说明 | 示例 |
|------|------|------|
| `VITE_API_BASE` | 后端地址(结尾无斜杠) | `https://xxx.onrender.com` |

> ⚠️ `.env` 已在 `.gitignore` 中,**切勿把含密码的连接串提交到仓库**。

---

## 四、故障排查(踩过的坑)

| 现象 | 原因 | 解决 |
|------|------|------|
| `password authentication failed for user "postgres"` | 连接串里 `[YOUR-PASSWORD]` **方括号没删**,或密码错,或用户名丢了 `.项目ref` 后缀 | 重新从 Supabase Connect→Session pooler 复制完整串,只换密码、去方括号;密码用纯字母数字(避开 `@ / : ?`) |
| 网页注册卡在"请稍候…" / 请求超时 | Render 免费实例休眠中,首次唤醒需 30-50s;或后端正在重新部署 | 等待或刷新重试;去 Render 看状态是否 Live |
| `Exited with status 1` | 后端启动时数据库连不上 | 检查 `DATABASE_URL`;看 Render deploy logs |
| 前端能开但连不上后端 / 跨域被拦 | `VITE_API_BASE` 没设/设错,或 `CLIENT_ORIGIN` 不匹配前端域名 | 核对两者;改了 Vercel 域名要同步更新 `CLIENT_ORIGIN` |
| 本地 MySQL(XAMPP)起不来,error 10013 | Windows(WSL2/Hyper-V)保留了端口;与本项目无关 | 本平台不用 MySQL,忽略即可 |

**成功启动的日志标志**:
```
🐘 Postgres schema 就绪          # 连上 Supabase(线上)
🎮 游戏平台服务器运行于 ...
```
