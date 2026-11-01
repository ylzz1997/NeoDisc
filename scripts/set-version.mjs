import {readFile,writeFile} from 'node:fs/promises';
const version=process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version??''))throw new Error('Usage: node scripts/set-version.mjs 0.1.0');
for (const file of ['package.json','package-lock.json','src-tauri/tauri.conf.json']) {
  const data=JSON.parse(await readFile(file,'utf8'));data.version=version;
  if(data.packages?.[''])data.packages[''].version=version;
  await writeFile(file,JSON.stringify(data,null,2)+'\n');
}
for (const file of ['src-tauri/Cargo.toml','src-tauri/Cargo.lock']) {
  const text=await readFile(file,'utf8');
  const next=text.replace(/(name = "lucent-cd"\r?\nversion = ")[^"]+"/,`$1${version}"`);
  if(next===text&&!text.includes(`name = "lucent-cd"\nversion = "${version}"`))throw new Error(`Cannot update ${file}`);
  await writeFile(file,next);
}
console.log(`NeoDisc version set to ${version}`);
