import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { EqualizerSettings } from './types';

export function useEqualizer(settings: EqualizerSettings, native: boolean) {
  const queue = useRef({ active: true, busy: false, version: 0, latest: null as { settings: EqualizerSettings; version: number } | null, timer: null as ReturnType<typeof setTimeout> | null });
  const [ready, setReady] = useState(!native);
  const [pending, setPending] = useState(native);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  function schedule() {
    const state = queue.current;
    if (!state.active || state.busy || state.timer || !state.latest) return;
    // Throttle (not debounce): sound keeps updating throughout a continuous drag.
    // At most one IPC is in flight; intermediate edits coalesce into the latest.
    state.timer = setTimeout(async () => {
      state.timer = null;
      if (!state.active || !state.latest) return;
      const request = state.latest;
      state.latest = null;
      state.busy = true;
      try {
        await invoke('set_equalizer', { settings: request.settings });
      } catch (failure) {
        if (state.active && request.version === state.version) setError(String(failure));
      } finally {
        state.busy = false;
        if (state.active && request.version === state.version) { setPending(false); setReady(true); }
        schedule();
      }
    }, 40);
  }
  useEffect(() => {
    const state = queue.current;
    state.active = true;
    return () => { state.active = false; if (state.timer) clearTimeout(state.timer); state.timer = null; state.latest = null; };
  }, []);
  useEffect(() => {
    if (!native) return;
    const state = queue.current;
    state.latest = { settings, version: ++state.version };
    setPending(true);
    setError(null);
    schedule();
  }, [settings, native, attempt]);
  return { ready, pending, error, retry: () => setAttempt(value => value + 1) };
}
