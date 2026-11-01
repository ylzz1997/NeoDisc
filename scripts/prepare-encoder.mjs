import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, chmod, rename, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const targetArgument=args.includes('--target')?args[args.indexOf('--target')+1]:undefined;
const target=process.env.NEODISC_ENCODER_TARGET || targetArgument || process.env.TAURI_ENV_TARGET_TRIPLE || (process.platform==='win32'?'x86_64-pc-windows-msvc':`${process.arch==='arm64'?'aarch64':'x86_64'}-apple-darwin`);
if (!['x86_64-pc-windows-msvc','aarch64-apple-darwin','x86_64-apple-darwin'].includes(target)) throw new Error(`Unsupported encoder target: ${target}`);
const windows=target.endsWith('windows-msvc');
if (windows !== (process.platform==='win32')) throw new Error('Prepare the Windows encoder on Windows and the macOS encoder on macOS.');
const revision=windows?'BtbN-n9.0.2-39-g7adfbe40dc-20261031':'FFmpeg-n9.0.2-LAME-4.0-minimal-2';
const encoderDir=join(root,'src-tauri/encoders');
const runtime=join(encoderDir,'runtime');
const binary=join(encoderDir,`ffmpeg-${target}${windows?'.exe':''}`);
const cache=join(root,'artifacts/encoder-download');
await mkdir(runtime,{recursive:true});
await mkdir(cache,{recursive:true});

async function hash(path) { const sum=createHash('sha256'); for await(const data of createReadStream(path))sum.update(data); return sum.digest('hex'); }
try {
  const saved=JSON.parse(await readFile(join(runtime,'encoder.json'),'utf8'));
  if(saved.target===target&&saved.revision===revision&&saved.sha256===await hash(binary)) {
    await stat(join(cache,'tools',windows?'ffprobe.exe':'ffprobe'));
    await stat(join(runtime,'FFmpeg-LICENSE.txt'));
    await stat(join(runtime,'NOTICE.txt'));
    console.log(`Encoder ready: ${revision} (${target})`);
    process.exit(0);
  }
} catch { /* Prepare missing or changed artifacts below. */ }
async function download(url,path,sha256) {
  try { if(await hash(path)===sha256)return; } catch {}
  console.log(`Downloading ${url}`);
  const partial=`${path}.download`;
  // SourceForge redirects can trigger an undici parser assertion on macOS.
  // Both supported operating systems provide curl; retain the pinned digest.
  await run(process.platform==='win32'?'curl.exe':'curl',[
    '--fail','--location','--show-error','--silent','--retry','3',
    '--retry-all-errors','--connect-timeout','30','--max-time','600',
    '--output',partial,url,
  ]);
  if(await hash(partial)!==sha256)throw new Error(`SHA-256 mismatch: ${url}`);
  await rename(partial,path);
}
async function run(program,parameters,options={}) {
  await new Promise((resolve,reject)=>{
    const child=spawn(program,parameters,{cwd:root,stdio:'inherit',windowsHide:true,...options});
    child.on('error',reject);
    child.on('exit',code=>code===0?resolve():reject(new Error(`${program} exited with ${code}`)));
  });
}
const sources=[];
if(windows) {
  const archive=join(cache,'ffmpeg-win64-lgpl.zip');
  const base='ffmpeg-n9.0.2-39-g7adfbe40dc-win64-lgpl-9.0';
  const url=`https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-31-12-59/${base}.zip`;
  await download(url,archive,'9d37c564e0d01c18cde184a079fa6ef04d7d2783ada41da81d04165cc8f1a650');
  await run('tar',['-xf',archive,'-C',cache,`${base}/bin/ffmpeg.exe`,`${base}/bin/ffprobe.exe`,`${base}/LICENSE.txt`]);
  await copyFile(join(cache,base,'bin/ffmpeg.exe'),binary);
  await mkdir(join(cache,'tools'),{recursive:true});
  await copyFile(join(cache,base,'bin/ffprobe.exe'),join(cache,'tools/ffprobe.exe'));
  await copyFile(join(cache,base,'LICENSE.txt'),join(runtime,'FFmpeg-LICENSE.txt'));
  sources.push(url,'https://github.com/FFmpeg/FFmpeg/tree/7adfbe40dc','https://github.com/BtbN/FFmpeg-Builds/tree/autobuild-2026-10-31-12-59');
} else {
  const ffmpeg=join(cache,'ffmpeg-source.tar.gz'),lame=join(cache,'lame-4.0.tar.gz');
  const ffmpegUrl='https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n9.0.2.tar.gz';
  const lameUrl='https://downloads.sourceforge.net/project/lame/lame/4.0/lame-4.0.tar.gz';
  await download(ffmpegUrl,ffmpeg,'6e374ed621e48faa40639307dff48ba6fe574a509977956d2cce9669b7cc27e9');
  await download(lameUrl,lame,'3df5124d5ad3a98312ffd7ba6a9b36230e4f8a3e66d3ce0f425e336c32d216eb');
  await run('bash',[join(root,'scripts/build-encoder-macos.sh'),ffmpeg,lame,join(cache,`build-${target}`),target,binary,runtime]);
  await chmod(binary,0o755);
  await mkdir(join(cache,'tools'),{recursive:true});
  await copyFile(join(cache,`build-${target}/FFmpeg-n9.0.2/ffprobe`),join(cache,'tools/ffprobe'));
  await chmod(join(cache,'tools/ffprobe'),0o755);
  sources.push(ffmpegUrl,lameUrl);
}
for(const codec of ['libmp3lame','aac'])await run(binary,['-hide_banner','-h',`encoder=${codec}`]);
const manifest={target,revision,sha256:await hash(binary),size:(await stat(binary)).size,sources};
await writeFile(join(runtime,'encoder.json'),JSON.stringify(manifest,null,2)+'\n');
await writeFile(join(runtime,'NOTICE.txt'),`NeoDisc audio encoder\n\nFFmpeg runs as a separate bundled executable.\n${revision}\nTarget: ${target}\n\nUpstream binaries, corresponding source and build recipes:\n${sources.join('\n')}\n\nPreparation and macOS build recipes: scripts/prepare-encoder.mjs and scripts/build-encoder-macos.sh in the NeoDisc source.\nSee the accompanying FFmpeg-LICENSE.txt (and LAME-LICENSE.txt on macOS).\n`);
console.log(`Prepared encoder: ${binary}`);
