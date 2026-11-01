import { test, expect, type Page } from '@playwright/test';
import type { EqualizerSettings } from '../src/types';
import { eqPresets } from '../src/equalizer';

async function desktop(page: Page, saved?: EqualizerSettings) {
  const controls = { calls: [] as string[], received: [] as EqualizerSettings[], applied: [] as EqualizerSettings[], failNext: false, holdNext: false, release: null as (() => void) | null, inflight: 0, maximumInflight: 0 };
  await page.exposeFunction('__eqInvoke', async (command: string, args: { settings?: EqualizerSettings }) => {
    if (command !== 'playback_status') controls.calls.push(command);
    switch (command) {
      case 'set_equalizer': {
        controls.received.push(args.settings!);
        controls.maximumInflight = Math.max(controls.maximumInflight, ++controls.inflight);
        try {
          if (controls.holdNext) { controls.holdNext = false; await new Promise<void>(resolve => { controls.release = resolve; }); }
          if (controls.failNext) { controls.failNext = false; throw new Error('EQ 频段增益必须在 -12 到 +12 dB 之间'); }
          controls.applied.push(args.settings!);
          return null;
        } finally { controls.inflight--; }
      }
      case 'list_drives': return [];
      case 'default_output': return 'C:/Music/NeoDisc';
      case 'select_audio_output': case 'player_action': case 'plugin:event|unlisten': return null;
      case 'plugin:event|listen': return 1;
      case 'playback_status': return { track: 1, playing: true, position: 42, duration: 180, volume: .5, error: null, ended: false };
      default: throw new Error(`Unexpected IPC: ${command}`);
    }
  });
  await page.addInitScript(settings => {
    if (settings && !localStorage.getItem('lucent.settings')) localStorage.setItem('lucent.settings', JSON.stringify({ equalizer: settings }));
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' } },
        transformCallback: () => 1,
        invoke: (window as unknown as { __eqInvoke: unknown }).__eqInvoke,
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  }, saved);
  return controls;
}

test('seven presets, keyboard fine-tuning, bypass and reset persist across launches', async ({ page }) => {
  const controls = await desktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '首选项', exact: true }).click();
  const card = page.locator('.equalizer-card');
  await expect(card.locator('.eq-status')).toHaveText('播放 EQ 已关闭');
  await expect(page.getByLabel('1000 Hz 频段', { exact: true })).toBeDisabled();
  const names = ['平直', '低音增强', '人声', '流行', '摇滚', '古典', '爵士'];
  for (const [i, name] of names.entries()) {
    await card.getByRole('button', { name, exact: true }).click();
    await expect(card.locator('.eq-status')).toHaveText('播放 EQ 已启用');
    expect(controls.applied.at(-1)).toEqual({ enabled: true, preampDb: eqPresets[i].preampDb, bands: eqPresets[i].bands });
  }
  await page.getByLabel('1000 Hz 频段', { exact: true }).press('ArrowUp');
  await expect(page.getByLabel('1000 Hz 频段', { exact: true })).toHaveAttribute('aria-valuenow', '-0.5');
  await expect(card.locator('.eq-current')).toHaveText('自定义');
  await expect(card.locator('.eq-status')).toHaveText('播放 EQ 已启用');
  await page.reload();
  await page.getByRole('button', { name: '首选项', exact: true }).click();
  await expect(page.getByLabel('1000 Hz 频段', { exact: true })).toHaveAttribute('aria-valuenow', '-0.5');
  await expect(card.locator('.eq-current')).toHaveText('自定义');
  await page.getByRole('switch', { name: '启用均衡器' }).click();
  await expect(card.locator('.eq-status')).toHaveText('播放 EQ 已关闭');
  expect(controls.applied.at(-1)?.bands[5]).toBe(-0.5);
  expect(controls.applied.at(-1)?.enabled).toBe(false);
  await page.getByRole('switch', { name: '启用均衡器' }).click();
  await expect(page.getByLabel('1000 Hz 频段', { exact: true })).toHaveAttribute('aria-valuenow', '-0.5');
  await card.getByRole('button', { name: '重置均衡器' }).click();
  await expect(card.locator('.eq-current')).toHaveText('平直');
  await expect(page.getByLabel('前级增益', { exact: true })).toHaveValue('0');
  await expect(card.locator('.eq-status')).toHaveText('播放 EQ 已启用');
  expect(controls.calls).not.toContain('play_track');
  expect(controls.calls.filter(command => command === 'player_action')).toHaveLength(2); // Only startup volume, once per load.
});

test('slow IPC coalesces newer edits without restarting transport, and failed updates can retry', async ({ page }) => {
  const controls = await desktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '首选项', exact: true }).click();
  await expect(page.locator('.eq-status')).toHaveText('播放 EQ 已关闭');
  controls.holdNext = true;
  await page.getByRole('button', { name: '摇滚', exact: true }).click();
  await expect.poll(() => controls.release !== null).toBe(true);
  const band = page.getByLabel('1000 Hz 频段', { exact: true });
  await band.press('ArrowUp');
  await band.press('ArrowUp');
  await band.press('ArrowUp');
  controls.release!();
  await expect(page.locator('.eq-status')).toHaveText('播放 EQ 已启用');
  expect(controls.maximumInflight).toBe(1);
  expect(controls.applied.at(-1)?.bands[5]).toBe(2.5);
  controls.failNext = true;
  await page.getByRole('button', { name: '低音增强', exact: true }).click();
  await expect(page.locator('.eq-error')).toContainText('EQ 频段增益必须在 -12 到 +12 dB 之间');
  await expect(page.locator('.eq-status')).toHaveText('应用失败');
  await page.getByRole('button', { name: '重试应用 EQ' }).click();
  await expect(page.locator('.eq-error')).toHaveCount(0);
  await expect(page.locator('.eq-status')).toHaveText('播放 EQ 已启用');
  expect(controls.applied.at(-1)?.bands).toEqual(eqPresets[1].bands);
  expect(controls.calls.filter(command => command === 'player_action')).toHaveLength(1);
});

test('compact dark and light layouts translate every EQ control', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.goto('/');
  await page.getByRole('button', { name: '首选项', exact: true }).click();
  await page.getByRole('button', { name: '摇滚', exact: true }).click();
  const card = page.locator('.equalizer-card');
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator('.eq-footer')).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: 'artifacts/equalizer-dark.png', animations: 'disabled' });
  expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.getByLabel('界面语言', { exact: true }).selectOption('en');
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole('button', { name: 'Rock', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('switch', { name: 'Enable equalizer' })).toBeChecked();
  await expect(page.getByLabel('1000 Hz band', { exact: true })).toHaveAttribute('aria-valuenow', '1');
  await expect(card).toContainText('Playback only. Ripped files stay unchanged.');
  await expect(card.locator('.eq-footer')).toBeInViewport({ ratio: 1 });
  expect(await card.innerText()).not.toMatch(/[\u4e00-\u9fff]/);
  expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/equalizer-light-en.png', animations: 'disabled' });
});

test('curve points drag in dB, clamp at the axis limits and reset independently', async ({ page }) => {
  const controls = await desktop(page);
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.goto('/');
  await page.getByRole('button', { name: '首选项', exact: true }).click();
  await page.getByRole('button', { name: '摇滚', exact: true }).click();
  await expect(page.locator('.eq-status')).toHaveText('播放 EQ 已启用');
  await page.locator('.equalizer-card').scrollIntoViewIfNeeded();
  const point = page.getByRole('slider', { name: '1000 Hz 频段', exact: true });
  const node = (await point.boundingBox())!;
  const chart = (await page.locator('.eq-chart').boundingBox())!;
  const initialCurve = await page.locator('.eq-curve-line').getAttribute('points');
  await page.mouse.move(node.x + node.width / 2, node.y + node.height / 2);
  await page.mouse.down();
  const beforeDrag = controls.applied.length;
  await page.mouse.move(node.x + node.width / 2, chart.y + 2, { steps: 30 });
  expect(controls.applied.length).toBeGreaterThan(beforeDrag + 1);
  await expect(point).toHaveAttribute('aria-valuenow', '12');
  await page.mouse.move(chart.x - 10, chart.y + chart.height - 2, { steps: 5 });
  await expect(point).toHaveAttribute('aria-valuenow', '-12');
  await page.mouse.up();
  expect(await page.locator('.eq-curve-line').getAttribute('points')).not.toBe(initialCurve);
  await expect(page.getByLabel('2000 Hz 频段', { exact: true })).toHaveAttribute('aria-valuenow', '3');
  await expect(page.getByLabel('前级增益', { exact: true })).toHaveValue('-6');
  await point.dblclick();
  await expect(point).toHaveAttribute('aria-valuenow', '0');
  await point.press('Shift+ArrowUp');
  await expect(point).toHaveAttribute('aria-valuenow', '2');
  await point.press('Enter');
  await expect(point).toHaveAttribute('aria-valuenow', '0');
  await point.press('Space');
  await expect(page.locator('.toast')).toHaveCount(0);
  await page.getByRole('switch', { name: '启用均衡器' }).click();
  await expect(point).toBeDisabled();
  await expect(point).toHaveAttribute('tabindex', '-1');
});
