import {test,expect} from '@playwright/test';

test.describe('English system language',()=>{
  test.use({locale:'en-US'});
  test('defaults to system, switches immediately, persists the override, and preserves music metadata',async({page})=>{
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang','en');
    await expect(page.getByRole('button',{name:'My CD',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Preferences',exact:true}).click();
    await expect(page.getByLabel('Interface language',{exact:true})).toHaveValue('system');
    await page.getByLabel('Interface language',{exact:true}).selectOption('zh-CN');
    await expect(page.locator('html')).toHaveAttribute('lang','zh-CN');
    await page.getByRole('button',{name:'我的 CD',exact:true}).click();
    await page.getByRole('button',{name:'编辑信息',exact:true}).click();
    await page.getByLabel('专辑名称',{exact:true}).fill('我的专辑 / My Album');
    await page.getByRole('button',{name:'保存信息',exact:true}).click();
    await page.getByRole('button',{name:'首选项',exact:true}).click();
    await page.getByLabel('界面语言',{exact:true}).selectOption('en');
    await page.getByRole('button',{name:'My CD',exact:true}).click();
    await expect(page.getByRole('heading',{name:'我的专辑 / My Album',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'MP3 Lossy',exact:true}).click();
    await page.getByRole('button',{name:'Encoding settings',exact:true}).click();
    await expect(page.getByLabel('Encoding sample rate',{exact:true})).toHaveValue('44100');
    await page.getByLabel('Encoding bitrate mode',{exact:true}).selectOption('vbr');
    await expect(page.getByLabel('VBR quality',{exact:true})).toBeVisible();
    await page.screenshot({path:'artifacts/i18n-encoding-en.png'});
    await page.getByRole('button',{name:'Save encoding settings',exact:true}).click();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang','en');
    await page.getByRole('button',{name:'Preferences',exact:true}).click();
    await expect(page.getByLabel('Interface language',{exact:true})).toHaveValue('en');
    await page.getByLabel('Interface language',{exact:true}).selectOption('system');
    await page.evaluate(()=>{Object.defineProperty(navigator,'languages',{configurable:true,get:()=>['zh-CN']});window.dispatchEvent(new Event('languagechange'));});
    await expect(page.locator('html')).toHaveAttribute('lang','zh-CN');
    await page.getByLabel('界面语言',{exact:true}).selectOption('en');
    await page.evaluate(()=>window.dispatchEvent(new Event('languagechange')));
    await expect(page.locator('html')).toHaveAttribute('lang','en');
  });

  test('English pages and encoding modal fit the minimum window size',async({page})=>{
    await page.setViewportSize({width:1000,height:720});await page.goto('/');
    await expect(page.getByRole('button',{name:'Close window',exact:true})).toBeInViewport();
    await page.getByRole('button',{name:'Preferences',exact:true}).click();
    await expect(page.getByLabel('Interface language',{exact:true})).toBeInViewport();
    await page.screenshot({path:'artifacts/i18n-preferences-en.png'});
    await page.getByRole('button',{name:'Appearance',exact:true}).first().click();
    await expect(page.getByRole('radio',{name:'Follow system',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'My CD',exact:true}).click();
    await page.getByRole('button',{name:'AAC M4A file',exact:true}).click();
    await page.getByRole('button',{name:'Encoding settings',exact:true}).click();
    await expect(page.getByRole('button',{name:'Save encoding settings',exact:true})).toBeInViewport();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.screenshot({path:'artifacts/i18n-compact-en.png'});
  });
});

test.describe('Unsupported system language',()=>{
  test.use({locale:'de-DE'});
  test('falls back to English',async({page})=>{
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang','en');
    await expect(page.getByRole('button',{name:'My CD',exact:true})).toBeVisible();
  });
});
