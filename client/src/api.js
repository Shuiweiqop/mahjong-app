const BASE = 'http://localhost:3001';

export const api = {
  getSessions: () => fetch(`${BASE}/api/sessions`).then(r => r.json()),
  getSession: (id) => fetch(`${BASE}/api/sessions/${id}`).then(r => r.json()),
  createSession: (name, players) =>
    fetch(`${BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, players }),
    }).then(r => r.json()),
  addRound: (sessionId, scores) =>
    fetch(`${BASE}/api/sessions/${sessionId}/rounds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scores }),
    }).then(r => r.json()),
  deleteLastRound: (sessionId) =>
    fetch(`${BASE}/api/sessions/${sessionId}/rounds/last`, {
      method: 'DELETE',
    }).then(r => r.json()),
};