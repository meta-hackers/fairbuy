type Fields = Record<string, unknown>;
const quietInfo = process.env.NODE_ENV === 'test' && process.env.FAIRBUY_LOG !== '1';
function line(level: 'info' | 'warn' | 'error', event: string, fields: Fields) {
  if (level === 'info' && quietInfo) return;
  // Structured, one-line logs are easier to filter in Render. Never pass chat text,
  // prompts, provider bodies, tokens or full URLs/query strings here.
  const entry = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.info(entry);
}
export const logger = {
  info: (event: string, fields: Fields = {}) => line('info', event, fields),
  warn: (event: string, fields: Fields = {}) => line('warn', event, fields),
  error: (event: string, fields: Fields = {}) => line('error', event, fields),
};
export function elapsedMs(startedAt: number) { return Date.now() - startedAt; }
