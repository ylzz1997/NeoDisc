import { test,expect,type Page } from '@playwright/test';

async function desktop(page:Page){
  await page.addInitScript(()=>{
    const calls:{command:string;args:Record<string,unknown>}[]=[];
    const disc={driveId:'E:',title:'测试专辑',artist:'测试艺术家',fingerprint:'encoder-test',tracks:[{number:1,title:'测试曲目',startSector:0,sectors:225,preEmphasis:false}]};
    Object.assign(window,{isTauri:true,__encoderTest:calls,__TAURI_INTERNALS__:{metadata:{currentWindow:{label:'main'}},transformCallback:()=>1,invoke:async(command:string,args:Record<string,unknown>={})=>{
      if(command!=='playback_status')calls.push({command,args});
      switch(command){
        case 'list_drives':return [{id:'E:',name:'Test CD'}];
        case 'read_disc':return disc;
        case 'identify_disc':return null;
        case 'default_output':return 'C:/Music/NeoDisc';
        case 'player_action':case 'select_audio_output':case 'plugin:event|unlisten':return null;
        case 'plugin:event|listen':return 1;
        case 'playback_status':return {track:null,playing:false,position:0,duration:0,volume:.5,error:null,ended:false};
        case 'start_rip':return 'C:/Music/NeoDisc/Test';
        case 'check_history_directories':return {'C:/Music/NeoDisc/Test':'available'};
        default:throw new Error(`Unexpected IPC command ${command}`);
      }
    }},__TAURI_EVENT_PLUGIN_INTERNALS__:{unregisterListener:()=>{}}});
  });
}
declare global{interface Window{__encoderTest:{command:string;args:Record<string,unknown>}[]}}

test('MP3 and AAC keep separate settings and send the selected encoding parameters to the ripper',async({page})=>{
  await desktop(page);await page.goto('/');
  await page.getByRole('button',{name:'MP3 有损压缩',exact:true}).click();
  await page.getByRole('button',{name:'编码详细设置',exact:true}).click();
  await page.getByLabel('编码采样率',{exact:true}).selectOption('48000');
  await page.getByLabel('编码码率模式',{exact:true}).selectOption('vbr');
  await expect(page.getByLabel('编码码率',{exact:true})).toHaveCount(0);
  await page.getByLabel('VBR 音质',{exact:true}).selectOption('0');
  await page.getByLabel('编码声道模式',{exact:true}).selectOption('mono');
  await page.getByLabel('MP3 编码精度',{exact:true}).selectOption('0');
  await page.screenshot({path:'artifacts/encoding-mp3-dark.png',animations:'disabled'});
  await page.getByRole('button',{name:'保存编码设置',exact:true}).click();
  await expect(page.locator('.encoding-shortcut')).toContainText('48 kHz · VBR · V0 · 单声道');
  await page.reload();
  await expect(page.locator('.encoding-shortcut')).toContainText('48 kHz · VBR · V0 · 单声道');
  await page.getByRole('button',{name:'开始抓轨 1',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.__encoderTest.find(call=>call.command==='start_rip')?.args)).toMatchObject({request:{format:'mp3',encoding:{sampleRate:48000,bitrateMode:'vbr',vbrQuality:0,channelMode:'mono',encoderQuality:0}}});
  await page.getByRole('button',{name:'抓轨记录 1',exact:true}).click();
  await expect(page.locator('.history-encoding')).toContainText('48 kHz · VBR · V0 · 单声道');
  await page.getByRole('button',{name:'我的 CD',exact:true}).click();
  await page.getByRole('button',{name:'AAC M4A 文件',exact:true}).click();
  await page.getByRole('button',{name:'编码详细设置',exact:true}).click();
  await expect(page.getByLabel('编码采样率',{exact:true})).toHaveValue('44100');
  await expect(page.getByLabel('编码码率',{exact:true})).toHaveValue('256');
  await expect(page.getByLabel('编码码率模式',{exact:true})).toBeDisabled();
  await page.getByLabel('编码采样率',{exact:true}).selectOption('16000');
  await page.getByLabel('编码声道模式',{exact:true}).selectOption('mono');
  await expect(page.getByLabel('编码码率',{exact:true})).toHaveValue('96');
  await expect(page.getByLabel('编码码率',{exact:true}).locator('option[value="320"]')).toHaveCount(0);
  await page.getByRole('button',{name:'保存编码设置',exact:true}).click();
  await page.getByRole('button',{name:'开始抓轨 1',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.__encoderTest.filter(call=>call.command==='start_rip').at(-1)?.args)).toMatchObject({request:{format:'aac',encoding:{sampleRate:16000,bitrateKbps:96,bitrateMode:'cbr',channelMode:'mono'}}});
  await page.getByRole('button',{name:'MP3 有损压缩',exact:true}).click();
  await expect(page.locator('.encoding-shortcut')).toContainText('48 kHz · VBR · V0 · 单声道');
  await page.getByRole('button',{name:'FLAC 无损压缩',exact:true}).click();
  await expect(page.getByRole('button',{name:'编码详细设置',exact:true})).toHaveCount(0);
});

test('encoding presets, cancel, keyboard controls and compact light mode remain usable',async({page})=>{
  await page.setViewportSize({width:1000,height:720});await page.goto('/');
  await page.getByRole('button',{name:'切换浅色模式',exact:true}).click();
  await page.getByRole('button',{name:'MP3 有损压缩',exact:true}).click();
  await page.getByRole('button',{name:'编码详细设置',exact:true}).click();
  await page.getByRole('button',{name:'高音质 320 kbps',exact:true}).click();
  await expect(page.getByLabel('编码码率',{exact:true})).toHaveValue('320');
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await expect(page.locator('.encoding-shortcut')).toContainText('192 kbps');
  await page.getByRole('button',{name:'编码详细设置',exact:true}).click();
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'AAC M4A 文件',exact:true}).click();
  await page.getByRole('button',{name:'编码详细设置',exact:true}).click();
  await expect(page.getByRole('button',{name:'保存编码设置',exact:true})).toBeInViewport();
  expect(await page.getByRole('dialog').evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await page.screenshot({path:'artifacts/encoding-aac-compact-light.png',animations:'disabled'});
});
