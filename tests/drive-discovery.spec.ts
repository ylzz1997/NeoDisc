import { test, expect, type Page } from '@playwright/test';
import type { Drive } from '../src/types';

declare global {
  interface Window {
    __driveDiscovery: { drives: Drive[]; reads: number; scans: number; stops: number; ready: boolean; ripping: boolean };
  }
}

const drive = { id: '/Volumes/Audio CD', name: 'Audio CD' };

async function desktop(page: Page) {
  await page.clock.install();
  await page.addInitScript(() => {
    const fixture = { drives: [] as Drive[], reads: 0, scans: 0, stops: 0, ready: true, ripping: false };
    Object.assign(window, {
      isTauri: true, __driveDiscovery: fixture,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' } }, transformCallback: () => 1,
        invoke: async (cmd: string, args: { action?: string }) => {
          switch (cmd) {
            case 'list_drives': fixture.scans++; return fixture.drives;
            case 'read_disc':
              fixture.reads++;
              if (!fixture.ready) throw 'The disc is still mounting';
              return { driveId: '/Volumes/Audio CD', fingerprint: 'disc', title: '新插入的唱片', artist: '测试音乐人',
                tracks: [1, 2].map(number => ({ number, title: `曲目 ${number}`, startSector: (number - 1) * 15000, sectors: 15000, preEmphasis: false })) };
            case 'identify_disc': return null;
            case 'default_output': return '/tmp/NeoDisc';
            case 'select_audio_output': return { selectedDevice: null, systemDefault: 'Speakers', activeDevice: 'Speakers', devices: [], error: null };
            case 'player_action': if (args.action === 'stop') fixture.stops++; return null;
            case 'play_track': case 'set_equalizer': return null;
            case 'playback_status': return { track: 1, playing: true, position: 2, duration: 200, volume: .5, error: null, ended: false };
            case 'start_rip': fixture.ripping = true; return new Promise(() => {});
            case 'plugin:event|listen': return 1;
            case 'plugin:event|unlisten': return null;
            default: throw new Error(`Unexpected IPC: ${cmd}`);
          }
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '刷新光盘', exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.__driveDiscovery.scans)).toBe(1);
}

test('detects a disc mounted after startup and preserves the loaded disc on later scans', async ({ page }) => {
  await desktop(page);
  await expect(page.locator('.track-row')).toHaveCount(0);
  await page.evaluate(value => { window.__driveDiscovery.drives = [value]; }, drive);
  await page.clock.runFor(2100);
  await expect(page.getByRole('heading', { name: '新插入的唱片', exact: true })).toBeVisible();
  await expect(page.locator('.track-row')).toHaveCount(2);
  await page.getByRole('checkbox', { name: '选择 曲目 1', exact: true }).uncheck();
  await page.clock.runFor(6100);
  await expect(page.getByRole('checkbox', { name: '选择 曲目 1', exact: true })).not.toBeChecked();
  expect(await page.evaluate(() => window.__driveDiscovery.reads)).toBe(1);
  expect(await page.evaluate(() => window.__driveDiscovery.stops)).toBe(0);
  await page.evaluate(() => { window.__driveDiscovery.drives = []; });
  await page.clock.runFor(2100);
  await expect(page.locator('.track-row')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '播放全部', exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.__driveDiscovery.stops)).toBe(1);
});

test('retries a disc that was listed before it became readable', async ({ page }) => {
  await desktop(page);
  await page.evaluate(value => { window.__driveDiscovery.drives = [value]; window.__driveDiscovery.ready = false; }, drive);
  await page.clock.runFor(2100);
  await expect.poll(() => page.evaluate(() => window.__driveDiscovery.reads)).toBe(1);
  await expect(page.getByRole('button', { name: '刷新光盘', exact: true })).toBeEnabled();
  await page.evaluate(() => { window.__driveDiscovery.ready = true; });
  await page.clock.runFor(2100);
  await expect(page.locator('.track-row')).toHaveCount(2);
  expect(await page.evaluate(() => window.__driveDiscovery.reads)).toBe(2);
});

test('does not scan or reread the drive during ripping', async ({ page }) => {
  await desktop(page);
  await page.evaluate(value => { window.__driveDiscovery.drives = [value]; }, drive);
  await page.clock.runFor(2100);
  await expect(page.locator('.track-row')).toHaveCount(2);
  await page.getByRole('button', { name: '开始抓轨 2', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__driveDiscovery.ripping)).toBe(true);
  const scans = await page.evaluate(() => window.__driveDiscovery.scans);
  await page.clock.runFor(6100);
  expect(await page.evaluate(() => window.__driveDiscovery.scans)).toBe(scans);
  expect(await page.evaluate(() => window.__driveDiscovery.reads)).toBe(1);
});
