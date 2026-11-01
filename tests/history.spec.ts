import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir, readFile, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HistoryEntry } from '../src/types';

function entry(id: string, path: string, title = '同一张专辑'): HistoryEntry {
  return { id, path, title, artist:'测试艺术家', date:`2026-11-01T06:0${id}:00.000Z`, format:'FLAC', tracks:10, verified:true };
}

async function fixture(testInfo: TestInfo) {
  const existing = testInfo.outputPath('专辑 · 已保存');
  const missing = testInfo.outputPath('专辑 · 已移走');
  await mkdir(existing, { recursive:true });
  return { existing, missing };
}

async function desktop(page: Page, entries: HistoryEntry[], unavailable: string[] = []) {
  // Simulate the IPC boundary with real, test-owned directories. Rust separately
  // tests its native filesystem checks; no OS file manager is opened here.
  const controls = { failChecks:false, unavailable:new Set(unavailable), beforeCheck:null as (() => Promise<void>) | null, opened:[] as string[], calls:[] as string[] };
  await page.exposeFunction('__historyInvoke', async (command: string, args: Record<string, unknown>) => {
    if (command !== 'playback_status') controls.calls.push(command);
    switch (command) {
      case 'check_history_directories': {
        const beforeCheck = controls.beforeCheck;
        controls.beforeCheck = null;
        if (beforeCheck) await beforeCheck();
        if (controls.failChecks) throw new Error('检查失败');
        return Object.fromEntries(await Promise.all((args.paths as string[]).map(async path => {
          if (controls.unavailable.has(path)) return [path,'unavailable'];
          try { return [path, (await stat(path)).isDirectory() ? 'available' : 'missing']; }
          catch (error) { return [path, ['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '') ? 'missing' : 'unavailable']; }
        })));
      }
      case 'open_folder': {
        const path = args.path as string;
        if (!await stat(path).then(s => s.isDirectory()).catch(() => false)) throw new Error('目录不存在，可能已被移动或删除。');
        controls.opened.push(path);
        return null;
      }
      case 'list_drives': return [];
      case 'default_output': return 'C:/Music/NeoDisc';
      case 'player_action':
      case 'select_audio_output':
      case 'plugin:event|unlisten': return null;
      case 'plugin:event|listen': return 1;
      case 'playback_status': return { track:null, playing:false, position:0, duration:0, volume:.5, error:null, ended:false };
      default: throw new Error(`Unexpected IPC command: ${command}`);
    }
  });
  await page.addInitScript(saved => {
    if (localStorage.getItem('lucent.history') === null) localStorage.setItem('lucent.history', JSON.stringify(saved));
    Object.assign(window, {
      isTauri:true,
      __TAURI_INTERNALS__: {
        metadata:{currentWindow:{label:'main'}},
        transformCallback:() => 1,
        invoke:(command: string, args: Record<string, unknown> = {}) => window.__historyInvoke(command,args),
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__:{unregisterListener:() => {}},
    });
  }, entries);
  await page.goto('/');
  await page.getByRole('button', { name:/^抓轨记录/ }).click();
  return controls;
}

declare global {
  interface Window { __historyInvoke: (command: string, args: Record<string, unknown>) => Promise<unknown> }
}

test('deleting one of two matching albums persists, can be undone, and leaves audio intact', async ({ page }, testInfo) => {
  const { existing, missing } = await fixture(testInfo);
  const audio = join(existing,'01.flac');
  await writeFile(audio,'original audio bytes');
  const controls = await desktop(page,[entry('2',existing),entry('1',missing)]);
  const items = page.getByRole('article');
  await expect(items).toHaveCount(2);
  await items.first().getByRole('button',{name:'打开文件夹',exact:true}).click();
  expect(controls.opened).toEqual([existing]);
  await items.first().getByRole('button',{name:'删除记录：同一张专辑',exact:true}).click();
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText(missing);
  await expect(page.locator('.nav-count')).toHaveText('1');
  await expect(page.getByRole('status')).toContainText('音频文件保留');
  expect(await readFile(audio,'utf8')).toBe('original audio bytes');
  await page.getByRole('button',{name:'撤销',exact:true}).click();
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText(existing);
  await items.first().getByRole('button',{name:'删除记录：同一张专辑',exact:true}).click();
  await page.reload();
  await page.getByRole('button',{name:/^抓轨记录/}).click();
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText(missing);
  await items.first().getByRole('button',{name:'删除记录：同一张专辑',exact:true}).click();
  await expect(page.getByRole('heading',{name:'下一次相遇，不必等光盘在身边'})).toBeVisible();
  await expect(page.locator('.nav-count')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button',{name:'抓轨记录',exact:true}).click();
  await expect(items).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lucent.history')!))).toEqual([]);
  expect(await readFile(audio,'utf8')).toBe('original audio bytes');
});

test('missing directories are visible and refresh after deletion, restoration and returning to history', async ({ page }, testInfo) => {
  const { existing, missing } = await fixture(testInfo);
  await desktop(page,[entry('2',existing,'好久不见 · Live at the Lake'),entry('1',missing,'留一点时间，给音乐')]);
  const available = page.getByRole('article',{name:'好久不见 · Live at the Lake的抓轨记录'});
  const gone = page.getByRole('article',{name:'留一点时间，给音乐的抓轨记录'});
  await expect(available.getByRole('button',{name:'打开文件夹'})).toBeEnabled();
  await expect(gone.getByText('目录不存在',{exact:true})).toBeVisible();
  await expect(gone.getByRole('button',{name:'打开文件夹'})).toBeDisabled();
  await page.screenshot({path:'artifacts/history-dark.png',animations:'disabled'});
  await rmdir(existing);
  await page.getByRole('button',{name:'刷新目录状态'}).click();
  await expect(available.getByText('目录不存在',{exact:true})).toBeVisible();
  await mkdir(existing);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(available.getByRole('button',{name:'打开文件夹'})).toBeEnabled();
  await mkdir(missing);
  // An external restore while this page stays open is noticed by the next poll.
  await expect(gone.getByRole('button',{name:'打开文件夹'})).toBeEnabled({timeout:8000});
  await page.getByRole('button',{name:'我的 CD',exact:true}).click();
  await rmdir(missing);
  await page.getByRole('button',{name:/^抓轨记录/}).click();
  await expect(gone.getByText('目录不存在',{exact:true})).toBeVisible();
  await page.setViewportSize({width:1000,height:720});
  await page.getByRole('button',{name:'切换浅色模式',exact:true}).click();
  await expect(gone.getByRole('button',{name:'删除记录：留一点时间，给音乐'})).toBeInViewport();
  expect(await page.locator('.content').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({path:'artifacts/history-compact-light.png',animations:'disabled'});
});

test('check failures do not claim deletion, and opening a just-removed folder updates its state', async ({ page }, testInfo) => {
  const { existing } = await fixture(testInfo);
  const controls = await desktop(page,[entry('1',existing)]);
  const item = page.getByRole('article');
  await expect(item.getByRole('button',{name:'打开文件夹'})).toBeEnabled();
  controls.failChecks = true;
  await page.getByRole('button',{name:'刷新目录状态'}).click();
  await expect(item.getByText('无法访问目录',{exact:true})).toBeVisible();
  await expect(item.getByText('目录不存在',{exact:true})).toHaveCount(0);
  await expect(item.getByRole('button',{name:'打开文件夹'})).toBeDisabled();
  controls.failChecks = false;
  await page.getByRole('button',{name:'刷新目录状态'}).click();
  await expect(item.getByRole('button',{name:'打开文件夹'})).toBeEnabled();
  await rmdir(existing);
  await item.getByRole('button',{name:'打开文件夹'}).click();
  await expect(page.getByRole('alert')).toContainText('目录不存在');
  await expect(item.getByText('目录不存在',{exact:true})).toBeVisible();
  await expect(item.getByRole('button',{name:'打开文件夹'})).toBeDisabled();
});

test('bulk cleanup removes every missing record, preserves unavailable folders and audio, and supports batch undo', async ({ page }, testInfo) => {
  const { existing, missing } = await fixture(testInfo);
  const unavailable = testInfo.outputPath('无法访问的磁盘');
  const audio = join(existing,'01.flac');
  await writeFile(audio,'original audio bytes');
  // Two exports may point to the same missing directory. Both records must go.
  await desktop(page,[entry('4',existing),entry('3',missing),entry('2',missing),entry('1',unavailable)],[unavailable]);
  const cleanup = page.getByRole('button',{name:'一键清理失效记录',exact:true});
  await expect(page.getByText('目录不存在',{exact:true})).toHaveCount(2);
  await expect(page.getByText('无法访问目录',{exact:true})).toHaveCount(1);
  await expect(cleanup.locator('.cleanup-count')).toHaveText('2');
  await cleanup.click();
  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(page.locator('.nav-count')).toHaveText('2');
  await expect(page.getByRole('status')).toContainText('已清理 2 条目录不存在的记录');
  await expect(page.getByText('无法访问目录',{exact:true})).toHaveCount(1);
  expect(await readFile(audio,'utf8')).toBe('original audio bytes');
  await page.screenshot({path:'artifacts/history-bulk-cleanup.png',animations:'disabled'});
  await page.getByRole('button',{name:'撤销',exact:true}).click();
  await expect(page.getByRole('article')).toHaveCount(4);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lucent.history')!).map((item: HistoryEntry) => item.id))).toEqual(['4','3','2','1']);
  await cleanup.click();
  await expect(page.getByRole('article')).toHaveCount(2);
  await page.reload();
  await page.getByRole('button',{name:/^抓轨记录/}).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lucent.history')!).map((item: HistoryEntry) => item.id))).toEqual(['4','1']);
  expect(await readFile(audio,'utf8')).toBe('original audio bytes');
});

test('cleanup rechecks restored directories, reports a no-op, and leaves all records intact when checking fails', async ({ page }, testInfo) => {
  const first = testInfo.outputPath('已恢复的目录');
  const second = testInfo.outputPath('仍然缺失的目录');
  const controls = await desktop(page,[entry('2',first),entry('1',second)]);
  const cleanup = page.getByRole('button',{name:'一键清理失效记录',exact:true});
  await expect(page.getByText('目录不存在',{exact:true})).toHaveCount(2);
  await mkdir(first,{recursive:true});
  await cleanup.click();
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('article')).toContainText(first);
  await expect(page.getByRole('status')).toContainText('已清理 1 条');
  await page.getByRole('button',{name:'撤销',exact:true}).click();
  await expect(page.getByRole('article')).toHaveCount(2);
  await mkdir(second,{recursive:true});
  await cleanup.click();
  await expect(page.getByRole('status')).toContainText('没有需要清理的记录');
  await expect(page.getByRole('article')).toHaveCount(2);
  await rmdir(first);
  controls.failChecks = true;
  await cleanup.click();
  await expect(page.getByRole('alert')).toContainText('未清理任何记录');
  await expect(page.getByRole('article')).toHaveCount(2);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lucent.history')!).map((item: HistoryEntry) => item.id))).toEqual(['2','1']);
});

test('leaving during a cleanup check cancels deletion, and an all-missing batch can be restored from empty history', async ({ page }, testInfo) => {
  const entries = [entry('2',testInfo.outputPath('不存在 A')),entry('1',testInfo.outputPath('不存在 B'))];
  const controls = await desktop(page,entries);
  const cleanup = page.getByRole('button',{name:'一键清理失效记录',exact:true});
  await expect(page.getByText('目录不存在',{exact:true})).toHaveCount(2);
  let finishCheck!: () => void;
  controls.beforeCheck = () => new Promise<void>(resolve => { finishCheck = resolve; });
  await cleanup.click();
  await expect(cleanup).toBeDisabled();
  await expect(cleanup).toContainText('正在检查');
  await expect.poll(() => typeof finishCheck).toBe('function');
  await page.getByRole('button',{name:'我的 CD',exact:true}).click();
  finishCheck();
  await page.getByRole('button',{name:/^抓轨记录/}).click();
  await expect(cleanup).toBeEnabled();
  await expect(page.getByRole('article')).toHaveCount(2);
  await cleanup.click();
  await expect(page.getByRole('article')).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'下一次相遇，不必等光盘在身边'})).toBeVisible();
  await expect(page.getByRole('status')).toContainText('已清理 2 条');
  await page.getByRole('button',{name:'撤销',exact:true}).click();
  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(page.locator('.nav-count')).toHaveText('2');
});
