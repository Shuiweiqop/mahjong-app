// 后端地址 —— 通过 Vite env 注入,替代原来硬编码的 Railway 死链。
// 本地开发默认 localhost:3001;部署时在 Vercel 设 VITE_API_BASE 指向 Render。
export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
