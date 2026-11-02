import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Inspect the shipped DMG, not just the binary in Cargo's build directory.
// A linker-signed ARM64 executable can run locally while its app bundle has
// no resource seal and is rejected after a browser download.
const [image, target] = process.argv.slice(2);
const arch = { 'aarch64-apple-darwin': 'arm64', 'x86_64-apple-darwin': 'x86_64' }[target];
if (process.platform !== 'darwin' || !image || !arch) {
  throw new Error('Usage on macOS: node scripts/verify-macos-package.mjs <dmg> <target>');
}
function run(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 60_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} failed: ${result.error ?? (result.stderr || result.stdout || result.signal || result.status)}`);
  }
  return result.stdout.trim();
}
const scratch = await mkdtemp(join(tmpdir(), 'neodisc-package-'));
const mount = join(scratch, 'mounted');
let mounted = false;
try {
  run('hdiutil', ['attach', resolve(image), '-readonly', '-nobrowse', '-mountpoint', mount, '-quiet']);
  mounted = true;
  const app = join(mount, 'NeoDisc.app');
  const executable = join(app, 'Contents/MacOS/NeoDisc');
  const encoder = join(app, 'Contents/MacOS/ffmpeg');
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  for (const binary of [executable, encoder]) {
    run('codesign', ['--verify', '--strict', binary]);
    if (run('lipo', ['-archs', binary]) !== arch) throw new Error(`Wrong architecture: ${binary}`);
  }
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const version = run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents/Info.plist')]);
  if (version !== pkg.version) throw new Error(`Packaged version ${version} does not match ${pkg.version}`);
  for (const file of ['encoder.json', 'NOTICE.txt', 'FFmpeg-LICENSE.txt', 'LAME-LICENSE.txt']) {
    await stat(join(app, 'Contents/Resources/encoders', file));
  }
  const manifest = JSON.parse(await readFile(join(app, 'Contents/Resources/encoders/encoder.json'), 'utf8'));
  if (manifest.target !== target) throw new Error('Packaged encoder manifest has the wrong target');

  // Exercise both lossy formats using the actual bundled sidecar and no tools
  // installed outside the app. Decode again to catch missing runtime codecs.
  const pcm = Buffer.alloc(44100 * 2 * 2);
  for (let frame = 0; frame < 44100; frame++) {
    const sample = Math.round(Math.sin(frame * 2 * Math.PI * 440 / 44100) * 8000);
    pcm.writeInt16LE(sample, frame * 4);
    pcm.writeInt16LE(sample, frame * 4 + 2);
  }
  const source = join(scratch, 'source.pcm');
  await writeFile(source, pcm);
  for (const [codec, extension] of [['libmp3lame', 'mp3'], ['aac', 'm4a']]) {
    const output = join(scratch, `encoded.${extension}`);
    run(encoder, ['-v', 'error', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', source, '-c:a', codec, '-b:a', '192k', output]);
    const decoded = join(scratch, `${extension}.pcm`);
    run(encoder, ['-v', 'error', '-i', output, '-f', 's16le', '-c:a', 'pcm_s16le', decoded]);
    if ((await stat(decoded)).size < pcm.length * 0.9) throw new Error(`${codec} round trip produced too little audio`);
  }

  let launchError;
  const child = spawn(executable, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', data => { log += data; });
  child.stderr.on('data', data => { log += data; });
  child.on('error', error => { launchError = error; });
  const closed = new Promise(resolve => child.on('close', resolve));
  try {
    await Promise.race([closed, delay(5000)]);
    if (launchError || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Packaged app failed to stay running: ${launchError ?? child.exitCode ?? child.signalCode}\n${log}`);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([closed, delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  }
  console.log(`Verified NeoDisc ${version} (${arch}): bundle signatures, packaged resources, MP3/AAC round trips and startup`);
} finally {
  if (mounted) run('hdiutil', ['detach', mount, '-quiet']);
  await rm(scratch, { recursive: true, force: true });
}
