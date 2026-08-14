import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {defineConfig} from '@playwright/test';

const port = 18080;
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
if (!existsSync(chromePath)) throw new Error(`Chrome was not found at ${chromePath}`);

const dataRoot = path.join(tmpdir(), `mdnotes-browser-${process.pid}`);

export default defineConfig({
  testDir: './test/browser',
  timeout: 30000,
  expect: {timeout: 5000},
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    launchOptions: {executablePath: chromePath},
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bash -lc "source /home/bets/env/go.sh && exec go run ."',
    cwd: process.cwd(),
    url: `http://127.0.0.1:${port}/`,
    timeout: 120000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      PORT: String(port),
      MDNOTES_PASSWORD: 'browser-test-password',
      MDNOTES_DIR: path.join(dataRoot, 'notes'),
      MDNOTES_DB: path.join(dataRoot, 'mdnotes.db'),
      GOCACHE: path.join(tmpdir(), 'mdnotes-browser-go-cache'),
    },
  },
});
