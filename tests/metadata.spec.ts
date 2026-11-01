import { test, expect, type Page } from '@playwright/test';
import type { AlbumMetadata, Disc } from '../src/types';

const recognized: AlbumMetadata = {
  discId: 'test-disc-id', releaseId: '01234567-1234-1234-1234-123456789abc',
  title: '晨光之间', artist: '测试音乐人',
  tracks: [{ number: 1, title: '初光', artist: '测试音乐人' }, { number: 2, title: '归途', artist: '另一位歌手' }],
  cover: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
};
declare global {
  interface Window {
    __metadataTest: { complete: (drive: string, result: AlbumMetadata | null, fail?: boolean) => void; pending: string[]; rip: { disc: Disc } | null };
  }
}
async function desktop(page: Page) {
  await page.addInitScript(() => {
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: string) => void }>();
    const fixture = {
      pending: [] as string[], rip: null as { disc: Disc } | null,
      complete: (drive: string, value: AlbumMetadata | null, fail = false) => {
        const job = pending.get(drive); if (!job) throw new Error('No lookup for ' + drive);
        if (fail) job.reject('Network unavailable'); else job.resolve(value);
      },
    };
    const output = { selectedDevice: null, systemDefault: 'Speakers', activeDevice: 'Speakers', devices: [], sampleRate: 48000, channels: 2, sampleFormat: 'F32', error: null, generation: 1 };
    Object.assign(window, {
      isTauri: true, __metadataTest: fixture,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' } }, transformCallback: () => 1,
        invoke: async (cmd: string, args: { driveId?: string; disc?: Disc; request?: { disc: Disc } }) => {
          switch (cmd) {
            case 'list_drives': return [{ id: 'E:', name: '光驱 E' }, { id: 'F:', name: '光驱 F' }];
            case 'read_disc': return { driveId: args.driveId, fingerprint: args.driveId, title: '未命名专辑', artist: '未知艺术家',
              lookupToc: { firstTrack: 1, lastTrack: 2, leadOut: 20150, offsets: [150, 10150] },
              tracks: [1, 2].map(number => ({ number, title: `曲目 0${number}`, startSector: (number - 1) * 10000, sectors: 10000, preEmphasis: false })) };
            case 'identify_disc': return new Promise((resolve, reject) => {
              const drive = args.disc!.driveId; pending.set(drive, { resolve, reject }); fixture.pending.push(drive);
            });
            case 'default_output': return 'C:/Music/NeoDisc';
            case 'select_audio_output': return output;
            case 'player_action': case 'set_equalizer': return null;
            case 'playback_status': return { track: null, playing: false, position: 0, duration: 0, volume: .5, error: null, ended: false, output };
            case 'start_rip': fixture.rip = args.request!; return 'C:/Music/NeoDisc/Test';
            case 'plugin:event|listen': return 1;
            case 'plugin:event|unlisten': return null;
            default: throw new Error(`Unexpected IPC: ${cmd}`);
          }
        },
      },
    });
  });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__metadataTest.pending)).toContain('E:');
}

test('NeoDisc uses amber by default and identifies automatically without blocking disc controls', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await desktop(page);
  await expect(page.locator('.brand')).toContainText('NeoDisc');
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'amber');
  await expect(page.getByRole('button', { name: '播放全部', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '开始抓轨 2', exact: true })).toBeEnabled();
  await page.evaluate(result => window.__metadataTest.complete('E:', result), recognized);
  await expect(page.getByRole('heading', { name: '晨光之间', exact: true })).toBeVisible();
  await expect(page.locator('.track-row').first()).toContainText('初光');
  await expect(page.getByAltText('专辑封面').first()).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/neodisc-recognition-fixture.png' });
  await page.getByRole('button', { name: '开始抓轨 2', exact: true }).click();
  const rip = await page.evaluate(() => window.__metadataTest.rip);
  expect(rip?.disc.metadataId).toBe(recognized.discId);
  expect(rip?.disc.tracks[1].artist).toBe('另一位歌手');
  expect(errors).toEqual([]);
});

for (const fail of [false, true]) test(`no match or unavailable network stays silent (${fail ? 'offline' : 'not found'})`, async ({ page }) => {
  await desktop(page);
  await page.evaluate(fail => window.__metadataTest.complete('E:', null, fail), fail);
  await expect(page.getByRole('heading', { name: '未命名专辑', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '播放全部', exact: true })).toBeEnabled();
});

test('late lookup from a previous disc cannot replace the current disc', async ({ page }) => {
  await desktop(page);
  await page.getByLabel('选择光驱', { exact: true }).selectOption('F:');
  await expect.poll(() => page.evaluate(() => window.__metadataTest.pending)).toContain('F:');
  await page.evaluate(result => window.__metadataTest.complete('E:', result), recognized);
  await expect(page.getByRole('heading', { name: '未命名专辑', exact: true })).toBeVisible();
  await page.evaluate(result => window.__metadataTest.complete('F:', result), { ...recognized, title: '第二张专辑' });
  await expect(page.getByRole('heading', { name: '第二张专辑', exact: true })).toBeVisible();
});

test('manual edits made during lookup take precedence over the late result', async ({ page }) => {
  await desktop(page);
  await page.getByRole('button', { name: '编辑信息', exact: true }).click();
  await page.getByLabel('专辑名称', { exact: true }).fill('我的专辑名称');
  await page.getByLabel('曲目 1 的名称', { exact: true }).fill('我的曲目名称');
  await page.getByRole('button', { name: '保存信息', exact: true }).click();
  await page.evaluate(result => window.__metadataTest.complete('E:', result), recognized);
  await expect(page.getByRole('heading', { name: '我的专辑名称', exact: true })).toBeVisible();
  await expect(page.locator('.track-row').first()).toContainText('我的曲目名称');
  await expect(page.getByAltText('专辑封面').first()).toBeVisible();
});

test('saving an open editor retains metadata that arrived while editing', async ({ page }) => {
  await desktop(page);
  await page.getByRole('button', { name: '编辑信息', exact: true }).click();
  await page.getByLabel('专辑名称', { exact: true }).fill('手动调整');
  await page.evaluate(result => window.__metadataTest.complete('E:', result), recognized);
  await expect(page.getByRole('heading', { name: '晨光之间', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存信息', exact: true }).click();
  await page.getByRole('button', { name: '开始抓轨 2', exact: true }).click();
  const rip = await page.evaluate(() => window.__metadataTest.rip);
  expect(rip?.disc.title).toBe('手动调整');
  expect(rip?.disc.metadataId).toBe(recognized.discId);
});
