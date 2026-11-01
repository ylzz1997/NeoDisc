import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', fullyParallel: false, workers: 1,
  use: { locale:'zh-CN', baseURL: 'http://127.0.0.1:1420', viewport: {width:1320,height:900}, channel: process.platform === 'win32' ? 'msedge' : 'chromium', trace:'retain-on-failure' },
  webServer: {command:'npm run dev',url:'http://127.0.0.1:1420',reuseExistingServer:true},
});
