// Operator commands, like Orchard's `orchardctl`. Run where the server runs:
//   node server/cli.js claim              new claim link (only while no account exists)
//   node server/cli.js login <user>       one-time sign-in link for a user (10 minutes), for lost passkeys
//   node server/cli.js users              list accounts
// In Docker:  docker exec recall node server/cli.js login vejas
import { db, initDb } from './db.js';
import { loadSettings, mintLink, userCount, findUserByLogin } from './auth.js';

const base = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const [cmd, arg] = process.argv.slice(2);

await initDb();
await loadSettings();
try {
  if (cmd === 'claim') {
    if ((await userCount()) > 0) throw new Error('This instance already has accounts. Use `login <user>` to get into one.');
    console.log(`Claim link (works once, 24 hours):\n  ${base}/claim/${await mintLink('claim')}`);
  } else if (cmd === 'login') {
    const u = arg && await findUserByLogin(arg);
    if (!u) throw new Error(`No account "${arg || ''}". Run \`users\` to list them.`);
    console.log(`One-time sign-in link for @${u.username} (works once, 10 minutes):\n  ${base}/auth/link/${await mintLink('login', u.id)}`);
  } else if (cmd === 'users') {
    for (const u of await db.all('SELECT username, email, is_admin FROM users ORDER BY id')) console.log(`${u.is_admin ? '★' : ' '} @${u.username}  ${u.email}`);
  } else {
    console.log('Usage: node server/cli.js claim | login <username|email> | users');
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }
await db.close();
