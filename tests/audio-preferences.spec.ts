import { test, expect, type Page } from '@playwright/test';
import type { AudioOutput } from '../src/types';

// Only the IPC boundary is simulated here. The native router has separate unit
// tests and an opt-in test against real audio endpoints and an actual CD.
async function mockDesktop(page: Page, savedDevice: string | null = null) {
  await page.addInitScript(({ savedDevice }) => {
    if (!localStorage.getItem('lucent.settings')) {
      localStorage.setItem('lucent.settings', JSON.stringify({ outputDevice: savedDevice }));
    }
    let selected: string | null = null;
    let systemDefault = 'Desktop speakers';
    const devices = ['Desktop speakers', 'USB headphones', 'HDMI monitor', 'Duplicate', 'Duplicate'];
    let generation = 0;
    let output: AudioOutput;
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    function route() {
      const active = selected || systemDefault;
      const available = devices.includes(active);
      output = {
        selectedDevice: selected, systemDefault, activeDevice: available ? active : null,
        devices: devices.map(name => ({ name, isDefault: name === systemDefault, selectable: name !== 'Duplicate' })),
        sampleRate: available ? active === 'USB headphones' ? 44100 : 48000 : null,
        channels: available ? 2 : null, sampleFormat: available ? 'F32' : null,
        error: available ? null : `首选设备“${active}”未连接。重新连接后点击播放，或选择其他输出。`,
        generation: ++generation,
      };
      return output;
    }
    route();
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' } },
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command !== 'playback_status') calls.push({ command, args });
          switch (command) {
            case 'list_drives': return [];
            case 'default_output': return 'C:/Music/Lucent';
            case 'player_action': case 'set_equalizer': return null;
            case 'select_audio_output':
              selected = args.deviceName as string | null;
              route();
              if (output.error) throw output.error;
              return structuredClone(output);
            case 'refresh_audio_outputs': return structuredClone(route());
            case 'playback_status': return { track: null, playing: false, position: 0, duration: 0, volume: .5, error: null, ended: false, output: structuredClone(output) };
            case 'plugin:event|listen': return 1;
            case 'plugin:event|unlisten': return null;
            default: throw new Error(`Unexpected IPC command: ${command}`);
          }
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __lucentAudioTest: { calls, setDefault: (name: string) => { systemDefault = name; route(); } },
    });
  }, { savedDevice });
}

declare global {
  interface Window {
    __lucentAudioTest: { calls: { command: string; args: Record<string, unknown> }[]; setDefault: (name: string) => void };
  }
}

test('preferences route audio, persist choice, follow default and send refresh/reconnect commands', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '首选项', exact: true }).click();
  const selector = page.getByLabel('音频输出设备', { exact: true });
  await expect(page.locator('.active-output')).toContainText('Desktop speakers');
  await expect(page.locator('.audio-format-grid')).toContainText('48 kHz');
  await selector.selectOption('USB headphones');
  await expect(page.locator('.active-output')).toContainText('USB headphones');
  await expect(page.locator('.audio-format-grid')).toContainText('44.1 kHz');
  await page.reload();
  await page.getByRole('button', { name: '打开首选项', exact: true }).click();
  await expect(selector).toHaveValue('USB headphones');
  await expect(page.locator('.active-output')).toContainText('USB headphones');
  await page.evaluate(() => window.__lucentAudioTest.setDefault('HDMI monitor'));
  await expect(page.locator('.system-output')).toContainText('HDMI monitor');
  await expect(page.locator('.active-output')).toContainText('USB headphones');
  await selector.selectOption('');
  await expect(page.locator('.active-output')).toContainText('HDMI monitor');
  await page.getByRole('button', { name: '刷新设备列表', exact: true }).click();
  await page.getByRole('button', { name: '重新连接输出', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('音频输出已重新连接');
  expect(await page.evaluate(() => window.__lucentAudioTest.calls.filter(c => c.command === 'refresh_audio_outputs').map(c => c.args.reconnect))).toEqual([false, true]);
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await page.screenshot({ path: 'artifacts/preferences-dark.png' });
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await page.screenshot({ path: 'artifacts/preferences-light.png' });
  expect(errors).toEqual([]);
});

test('unavailable saved output remains selected and can recover without restarting', async ({ page }) => {
  await mockDesktop(page, 'Disconnected DAC');
  await page.goto('/');
  await page.getByRole('button', { name: '首选项', exact: true }).click();
  await expect(page.getByLabel('音频输出设备', { exact: true })).toHaveValue('Disconnected DAC');
  await expect(page.locator('.audio-error')).toContainText('首选设备“Disconnected DAC”未连接');
  await expect(page.locator('.active-output')).toContainText('尚未连接音频输出');
  await expect(page.locator('.audio-format-grid')).not.toContainText('kHz');
  await expect(page.locator('option[value="Duplicate"]').first()).toBeDisabled();
  await page.getByLabel('音频输出设备', { exact: true }).selectOption('');
  await expect(page.locator('.audio-error')).toHaveCount(0);
  await expect(page.locator('.active-output')).toContainText('Desktop speakers');
  await expect(page.locator('.audio-state-badge')).toHaveText('输出已就绪');
});

test('preview exposes preferences without inventing hardware and fits minimum window size', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.goto('/');
  await page.getByRole('button', { name: '打开首选项', exact: true }).click();
  await expect(page.getByLabel('音频输出设备', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '刷新设备列表', exact: true })).toBeDisabled();
  await expect(page.locator('.active-output')).toContainText('请在桌面版查看真实设备');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: '关闭窗口', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'artifacts/preferences-compact.png' });
});
