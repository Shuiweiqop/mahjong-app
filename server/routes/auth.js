// Auth routes —— they go through the db layer (Postgres or the in-memory fallback) and return { token, user }.
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');

// The JWT secret. There must never be a hardcoded fallback value here: a secret written into open-source code
// means anyone can sign a token for any user (the socket layer trusts the id inside the token, so a forged one
// lets an attacker take someone else's place when reconnecting into a room, and the match record would be
// credited to that other person too). Worse, such a degradation is silent —— the service starts as usual and
// logging in works as usual.
//
// So there are two paths depending on the environment, and neither hands out a "fake secret that looks usable":
//   Production (DATABASE_URL is set, i.e. real users are actually being stored) → exit on a missing secret, do not start.
//   Local development → use a secret generated randomly on each startup. Random rather than fixed, so that old
//             tokens expire naturally after a restart, avoiding the illusion that because "it always works
//             locally" it must be fine in production too.
const IS_PROD = !!process.env.DATABASE_URL;
const JWT_SECRET = resolveSecret();

function resolveSecret() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;

  if (IS_PROD) {
    console.error(
      fromEnv
        ? '❌ JWT_SECRET is too short (at least 16 characters), refusing to start.'
        : '❌ DATABASE_URL detected (production environment) but JWT_SECRET is not set, refusing to start.\n' +
          '   Without a secret, login sessions cannot be issued securely. Please set JWT_SECRET on your deployment platform (on Render you can use generateValue).'
    );
    process.exit(1);
  }
  console.warn('⚠️  JWT_SECRET is not set, this startup is using a random secret (login sessions expire after a restart). For local development only.');
  return crypto.randomBytes(32).toString('hex');
}

const router = express.Router();

const sign = (u) => jwt.sign({ id: u.id, email: u.email, name: u.name }, JWT_SECRET, { expiresIn: '30d' });

// bcrypt truncates at 72 bytes, and anything beyond that takes no part in the hash at all —— if this is not
// blocked, a user who sets a 100-character password really only has the first 72 characters in effect, and the
// 72-character and 100-character passwords will both pass verification against each other.
// Rather than truncating silently, it is better to reject outright and explain why.
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;
const NAME_MAX = 20;          // display names are broadcast to the whole room, so they need an upper bound
const EMAIL_MAX = 254;        // the address length limit from RFC 5321
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Returns an error code, or null if validation passes.
// Two of these codes need a number in the message, so they carry it as a suffix
// after a colon: the client splits on ':' and interpolates (see serverError()).
// Keeping the number out of the code itself means the limits can change without
// touching either translation table.
function validateCredentials(email, password) {
  if (!email || !password) return 'auth.missingFields';
  if (typeof email !== 'string' || typeof password !== 'string') return 'auth.badParams';
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return 'auth.badEmail';
  // Measured in bytes: a Chinese password character is up to 4 bytes, so judging by string length would miss cases
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes < PASSWORD_MIN) return `auth.passwordTooShort:${PASSWORD_MIN}`;
  if (bytes > PASSWORD_MAX) return `auth.passwordTooLong:${PASSWORD_MAX}`;
  return null;
}

router.post('/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  const invalid = validateCredentials(email, password);
  if (invalid) return res.status(400).json({ error: invalid });
  const displayName = typeof name === 'string' ? name.trim().slice(0, NAME_MAX) : name;
  try {
    const { user, error } = await db.createUser(email, password, displayName);
    if (error) return res.status(400).json({ error });
    res.json({ token: sign(user), user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  // Login only does type / non-empty checks and does not apply the registration strength rules —— the passwords
  // of existing users who registered before the rules were tightened may not satisfy the new rules, and using
  // those rules to block login would lock them out. Whether the password is correct is decided by
  // bcrypt.compare.
  if (!email || !password) return res.status(400).json({ error: 'auth.missingFields' });
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'auth.badParams' });
  }
  try {
    const { user, error } = await db.loginUser(email, password);
    if (error) return res.status(400).json({ error });
    res.json({ token: sign(user), user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/me', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'auth.notLoggedIn' });
  try {
    res.json({ user: jwt.verify(token, JWT_SECRET) });
  } catch {
    res.status(401).json({ error: 'auth.badToken' });
  }
});

module.exports = { router, JWT_SECRET };
