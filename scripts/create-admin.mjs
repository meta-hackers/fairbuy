import { randomBytes, scryptSync } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { parseEnv } from 'node:util';

// Run from the repository root. Passwords are generated, never accepted in argv.
const username = process.argv[2];
if (!username || !/^[a-zA-Z0-9_.-]{1,80}$/.test(username)) throw new Error('Usage: npm run admin:create -- Alberto');
const file = new URL('../.env.backoffice', import.meta.url);
let existing = '';
try { existing = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const env = parseEnv(existing);
const admins = JSON.parse(env.BACKOFFICE_ADMINS || process.env.BACKOFFICE_ADMINS || '[]');
if (!Array.isArray(admins)) throw new Error('BACKOFFICE_ADMINS must be a JSON array.');
if (admins.some(admin => admin.username.toLowerCase() === username.toLowerCase())) throw new Error('This administrator already exists. Remove that entry explicitly before rotating their password.');
const password = randomBytes(24).toString('base64url');
const salt = randomBytes(16).toString('hex');
admins.push({ username, passwordHash: `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}` });
// This ignored file stores hashes only. Existing unrelated environment settings are preserved.
const otherLines = existing.split('\n').filter(line => !/^\s*BACKOFFICE_ADMINS\s*=/.test(line));
await writeFile(file, `${otherLines.filter(Boolean).join('\n')}\nBACKOFFICE_ADMINS='${JSON.stringify(admins)}'\n`, { mode: 0o600 });
await chmod(file, 0o600);
console.log(`Administrator: ${username}\nPassword (save it now): ${password}\nHash configuration saved to .env.backoffice. Restart the backend to apply.\nFor production, set BACKOFFICE_ADMINS to the JSON value in that file (without the surrounding single quotes).`);
