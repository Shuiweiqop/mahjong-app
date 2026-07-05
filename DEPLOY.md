# 部署指南 —— Playground 多人游戏平台

三个免费服务:**Supabase**(数据库) + **Render**(后端) + **Vercel**(前端)。

---

## 1. Supabase(数据库)

1. 注册 https://supabase.com → New project(记住数据库密码)。
2. 左侧 **SQL Editor** → 新建查询 → 粘贴 `server/schema.sql` 全部内容 → Run。
3. **Project Settings → Database → Connection string → URI**,复制连接串,
   把 `[YOUR-PASSWORD]` 换成你设的密码。这就是后端要的 `DATABASE_URL`。

## 2. Render(后端 Socket.io)

1. 注册 https://render.com,连接 GitHub。
2. New → **Web Service** → 选本仓库 → 设置:
   - Root Directory: `server`
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Instance Type: **Free**
3. Environment 里加变量:
   - `DATABASE_URL` = 上一步的 Supabase 连接串
   - `JWT_SECRET` = 一串长随机字符
   - `CLIENT_ORIGIN` = 前端 Vercel 域名(第 3 步拿到后回填)
4. 部署完成后记下后端地址,如 `https://playground-server.onrender.com`。

> 免费实例闲置会休眠,首次访问需等 ~30-50 秒唤醒(作品集可接受)。
> 可用 UptimeRobot(免费)每 5 分钟 ping `/api/health` 保活。

## 3. Vercel(前端)

1. 注册 https://vercel.com,连接 GitHub。
2. Import 本仓库 → 设置:
   - **Root Directory: `client`**
   - Framework: Vite(自动识别)
3. Environment Variables 加:
   - `VITE_API_BASE` = Render 后端地址(第 2 步的)
4. Deploy。拿到前端地址,如 `https://playground-xxx.vercel.app`。
5. **回到 Render**,把 `CLIENT_ORIGIN` 设为这个 Vercel 地址,重新部署后端。

## 4. 验证

打开 Vercel 前端地址 → 注册/访客 → 创建房间 → 换设备/无痕窗口用房间码加入 → 对战。
