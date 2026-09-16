// Backend address, injected through the Vite env -- this replaced a hardcoded
// Railway URL that had gone dead.
// Local development defaults to localhost:3001; for deploys, set VITE_API_BASE on
// Vercel to point at Render.
export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
