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
    __metadataTest: { complete: (drive: string, result: AlbumMetadata | null, fail?: boolean) => void; pending: string[]; rip: { disc: Disc } | null; calls: string[]; refreshes: boolean[] };
  }
}
async function desktop(page: Page, autoMetadata = true) {
  await page.addInitScript(autoMetadata => {
    if (!autoMetadata && !localStorage.getItem('lucent.settings')) localStorage.setItem('lucent.settings', JSON.stringify({ autoMetadata: false }));
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: string) => void }>();
    const fixture = {
      pending: [] as string[], rip: null as { disc: Disc } | null,
      calls: [] as string[], refreshes: [] as boolean[],
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
        invoke: async (cmd: string, args: { driveId?: string; disc?: Disc; request?: { disc: Disc }; refresh?: boolean }) => {
          if (cmd !== 'playback_status') fixture.calls.push(cmd);
          switch (cmd) {
            case 'list_drives': return [{ id: 'E:', name: '光驱 E' }, { id: 'F:', name: '光驱 F' }];
            case 'read_disc': return { driveId: args.driveId, fingerprint: args.driveId, title: '未命名专辑', artist: '未知艺术家',
              lookupToc: { firstTrack: 1, lastTrack: 2, leadOut: 20150, offsets: [150, 10150] },
              tracks: [1, 2].map(number => ({ number, title: `曲目 0${number}`, startSector: (number - 1) * 10000, sectors: 10000, preEmphasis: false })) };
            case 'identify_disc': return new Promise((resolve, reject) => {
              fixture.refreshes.push(!!args.refresh);
              const drive = args.disc!.driveId; pending.set(drive, { resolve, reject }); fixture.pending.push(drive);
            });
            case 'default_output': return 'C:/Music/NeoDisc';
            case 'select_audio_output': return output;
            case 'player_action': case 'set_equalizer': case 'cancel_metadata_lookup': return null;
            case 'playback_status': return { track: null, playing: false, position: 0, duration: 0, volume: .5, error: null, ended: false, output };
            case 'start_rip': fixture.rip = args.request!; return 'C:/Music/NeoDisc/Test';
            case 'plugin:event|listen': return 1;
            case 'plugin:event|unlisten': return null;
            default: throw new Error(`Unexpected IPC: ${cmd}`);
          }
        },
      },
    });
  }, autoMetadata);
  await page.goto('/');
  if (autoMetadata) await expect.poll(() => page.evaluate(() => window.__metadataTest.pending)).toContain('E:');
  else await expect(page.getByRole('heading', { name: '未命名专辑', exact: true })).toBeVisible();
}

test('retry identifies again without rereading the drive and bypasses the miss cache', async ({ page }) => {
  await desktop(page);
  await page.evaluate(() => window.__metadataTest.complete('E:', null));
  await expect(page.getByRole('status')).toContainText('未找到可靠匹配');
  await page.getByRole('button', { name: '重新识别', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__metadataTest.refreshes)).toEqual([false, true]);
  await page.evaluate(result => window.__metadataTest.complete('E:', result), { ...recognized, source: 'CUETools DB · FreeDB' });
  await expect(page.getByRole('heading', { name: '晨光之间', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('CUETools DB · FreeDB');
  expect(await page.evaluate(() => window.__metadataTest.calls.filter(call => call === 'read_disc').length)).toBe(1);
});

test('disabling lookup rejects late results and persists across refresh and restart', async ({ page }) => {
  await desktop(page);
  await page.getByRole('button', { name: '首选项', exact: true }).click();
  const toggle = page.getByRole('switch', { name: '自动识别 CD 信息', exact: true });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => window.__metadataTest.calls)).toContain('cancel_metadata_lookup');
  await page.getByRole('button', { name: '我的 CD', exact: true }).click();
  await page.evaluate(result => window.__metadataTest.complete('E:', result), recognized);
  await expect(page.getByRole('heading', { name: '未命名专辑', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('自动识别已关闭');
  await page.getByRole('button', { name: '刷新光盘', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__metadataTest.calls.filter(call => call === 'read_disc').length)).toBe(2);
  expect(await page.evaluate(() => window.__metadataTest.pending)).toEqual(['E:']);
  await page.reload();
  await expect(page.getByRole('heading', { name: '未命名专辑', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__metadataTest.pending)).toEqual([]);
  await page.getByRole('button', { name: '首选项', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await page.screenshot({ path: 'artifacts/metadata-settings-disabled.png' });
});

test('enabling lookup identifies the loaded disc and disabling keeps the result', async ({ page }) => {
  await desktop(page, false);
  expect(await page.evaluate(() => window.__metadataTest.pending)).toEqual([]);
  await page.getByRole('button', { name: '首选项', exact: true }).click();
  const toggle = page.getByRole('switch', { name: '自动识别 CD 信息', exact: true });
  await toggle.click();
  await expect.poll(() => page.evaluate(() => window.__metadataTest.pending)).toEqual(['E:']);
  await page.evaluate(result => window.__metadataTest.complete('E:', result), recognized);
  await page.getByRole('button', { name: '我的 CD', exact: true }).click();
  await expect(page.getByRole('heading', { name: '晨光之间', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '首选项', exact: true }).click();
  await toggle.click();
  await page.getByRole('button', { name: '我的 CD', exact: true }).click();
  await expect(page.getByRole('heading', { name: '晨光之间', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('自动识别已关闭');
  expect(await page.evaluate(() => window.__metadataTest.calls.filter(call => call === 'read_disc').length)).toBe(1);
});

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

const detailed: AlbumMetadata = {
  ...recognized,
  cover: null,
  details: { year: '2006', genre: 'Jazz / Pop', discNumber: 2, discTotal: 3, label: 'Studio Records', copyright: null, encodedBy: null, url: 'https://example.com/album', compilation: true, comment: '专辑附注\n第二行' },
  tracks: recognized.tracks.map((track, index) => ({ ...track, details: index === 0 ? { rating: 4.5, composer: '测试作曲家', comment: '曲目附注' } : { composer: '另一位作曲家' } })),
};

test('track details show unknown fields, update after automatic lookup and do not affect playback or selection', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 720 });
  await desktop(page);
  await page.getByRole('button', { name: '查看“曲目 01”的详情', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '曲目详情', exact: true });
  const field = (name: string) => dialog.locator('.detail-field').filter({ has: page.getByText(name, { exact: true }) }).locator('dd');
  await expect(field('年份')).toHaveText('未知');
  await expect(field('等级')).toHaveText('未知');
  await expect(field('合辑的一部分')).toHaveText('未知');
  await expect(dialog.locator('.track-details-note')).toContainText('正在自动识别元信息');
  await expect(dialog.getByRole('button', { name: '完成', exact: true })).toBeInViewport();
  await page.evaluate(meta => window.__metadataTest.complete('E:', meta), detailed);
  await expect(field('专辑艺术家')).toHaveText('测试音乐人');
  await expect(field('年份')).toHaveText('2006');
  await expect(field('光盘号')).toHaveText('2 / 3');
  await expect(field('发行商')).toHaveText('Studio Records');
  await expect(field('版权')).toHaveText('未知');
  await expect(field('编码者')).toHaveText('未知');
  await expect(field('URL')).toHaveText('https://example.com/album');
  await expect(field('等级')).toContainText('4.5 / 5');
  await expect(field('作曲家')).toHaveText('测试作曲家');
  await expect(field('合辑的一部分')).toHaveText('是');
  await expect(field('注释')).toHaveText('曲目附注');
  await expect(field('采样率')).toHaveText('44.1 kHz'); // Output endpoint is 48 kHz in this fixture.
  await expect(field('位深')).toHaveText('16-bit');
  await expect(field('编号')).toHaveText('1 / 2');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/track-details-dark.png', animations: 'disabled' });
  await dialog.getByRole('button', { name: '关闭曲目详情', exact: true }).press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '查看“初光”的详情', exact: true })).toBeFocused();
  await expect(page.getByLabel('选择 初光', { exact: true })).toBeChecked();
  await page.locator('.track-details-button').first().dispatchEvent('dblclick');
  expect(await page.evaluate(() => window.__metadataTest.calls)).not.toContain('play_track');
  await page.getByLabel('搜索当前 CD 的曲目', { exact: true }).fill('归途');
  await page.getByRole('button', { name: '查看“归途”的详情', exact: true }).click();
  await expect(field('编号')).toHaveText('2 / 2');
  await expect(field('音轨艺术家')).toHaveText('另一位歌手');
  await expect(field('注释')).toHaveText('专辑附注\n第二行');
});

test('English details retain music text, show zero ratings and false compilation, and keep local edits', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 720 });
  await desktop(page);
  const metadata = structuredClone(detailed);
  metadata.details!.compilation = false;
  metadata.tracks[0].details!.rating = 0;
  metadata.tracks[0].details!.comment = '<script>not executable</script>\nA long note / '.repeat(20);
  await page.evaluate(meta => window.__metadataTest.complete('E:', meta), metadata);
  await page.getByRole('button', { name: '编辑信息', exact: true }).click();
  await page.getByLabel('专辑名称', { exact: true }).fill('我的专辑 / My album');
  await page.getByLabel('曲目 1 的名称', { exact: true }).fill('本地曲名 / Local title');
  await page.getByRole('button', { name: '保存信息', exact: true }).click();
  await page.getByRole('button', { name: '首选项', exact: true }).click();
  await page.getByLabel('界面语言', { exact: true }).selectOption('en');
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  await page.getByRole('button', { name: 'My CD', exact: true }).click();
  await page.getByRole('button', { name: 'View details for “本地曲名 / Local title”', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Track details', exact: true });
  const field = (name: string) => dialog.locator('.detail-field').filter({ has: page.getByText(name, { exact: true }) }).locator('dd');
  await expect(field('Album')).toHaveText('我的专辑 / My album');
  await expect(field('Title')).toHaveText('本地曲名 / Local title');
  await expect(field('Composer')).toHaveText('测试作曲家');
  await expect(field('Rating')).toContainText('0.0 / 5');
  await expect(field('Part of a compilation')).toHaveText('No');
  await expect(field('Copyright')).toHaveText('Unknown');
  await expect(field('Comment')).toContainText('<script>not executable</script>');
  await expect(dialog.locator('script')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/track-details-light-en.png', animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Close track details', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close track details', exact: true })).toBeFocused();
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
