import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { scryptSync } from 'node:crypto';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
export default defineConfig({
  testDir: 'e2e', timeout: 45000, fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:3001', trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: { executablePath } },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-390', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
    { name: 'mobile-320', use: { viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: 'npm start', url: 'http://127.0.0.1:3001/healthz', reuseExistingServer: false, env: { FAIRBUY_MODE: 'demo', DATABASE_URL: '', APP_ACCESS_TOKEN: '', NODE_ENV: 'test', PORT: '3001', BACKOFFICE_ADMINS: JSON.stringify([{ username: 'TestAdmin', passwordHash: `scrypt:${'a'.repeat(32)}:${scryptSync('e2e-only-password', 'a'.repeat(32), 64).toString('hex')}` }]) } },
});
