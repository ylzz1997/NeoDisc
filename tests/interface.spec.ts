import { test,expect } from '@playwright/test';

test('skins, light/dark, schedule, and persisted settings',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await expect(page.getByText('界面预览 · 示例曲目仅用于展示，播放和抓轨需要桌面版。')).toBeVisible();
  await page.screenshot({path:'artifacts/preview-dark.png'});
  await page.getByRole('button',{name:'切换浅色模式',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await page.screenshot({path:'artifacts/preview-light.png'});
  await page.getByRole('button',{name:'外观与皮肤',exact:true}).click();
  await page.getByRole('button',{name:/深林 · 青苔/}).click();
  await expect(page.locator('html')).toHaveAttribute('data-skin','forest');
  await page.getByRole('radio',{name:'深色',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.getByRole('radio',{name:'定时夜间',exact:true}).click();
  await page.getByLabel('夜间模式开始时间').fill('00:00');await page.getByLabel('夜间模式结束时间').fill('00:00');
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.reload();await expect(page.locator('html')).toHaveAttribute('data-skin','forest');
  await page.getByRole('button',{name:'外观与皮肤',exact:true}).click();
  await expect(page.getByRole('radio',{name:'定时夜间',exact:true})).toBeChecked();
  await expect(page.getByLabel('夜间模式开始时间')).toHaveValue('00:00');
  await page.getByRole('button',{name:/暖夜 · 琥珀/}).click();await page.getByRole('radio',{name:'跟随系统',exact:true}).click();
  await page.emulateMedia({colorScheme:'light'});await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await page.emulateMedia({colorScheme:'dark'});await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.screenshot({path:'artifacts/preview-skins.png'});expect(errors).toEqual([]);
});

test('track selection, search, metadata, and honest preview actions',async({page})=>{
  await page.goto('/');await page.getByLabel('选择全部曲目',{exact:true}).uncheck();
  await expect(page.getByRole('button',{name:'开始抓轨 0',exact:true})).toBeDisabled();
  await page.getByLabel('选择 First light / 初光',{exact:true}).check();
  await expect(page.getByRole('button',{name:'开始抓轨 1',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'开始抓轨 1',exact:true}).click();await expect(page.getByRole('status')).toContainText('不会生成抓轨文件');
  await page.getByRole('button',{name:'关闭提示',exact:true}).click();
  await page.getByLabel('搜索当前 CD 的曲目',{exact:true}).fill('Sunday');
  await expect(page.locator('.track-row')).toHaveCount(1);await expect(page.locator('.track-row')).toContainText('Slow Sunday');
  await page.getByLabel('搜索当前 CD 的曲目',{exact:true}).fill('');
  await page.getByRole('button',{name:'编辑信息',exact:true}).click();
  await page.getByLabel('专辑名称',{exact:true}).fill('测试专辑 / Test album');await page.getByLabel('艺术家',{exact:true}).fill('Test artist');
  await page.getByLabel('曲目 1 的名称',{exact:true}).fill('新的曲目名');
  await page.getByRole('button',{name:'保存信息',exact:true}).click();
  await expect(page.getByRole('heading',{name:'测试专辑 / Test album',exact:true})).toBeVisible();
  await expect(page.locator('.track-row').first()).toContainText('新的曲目名');
  await page.getByRole('button',{name:'抓轨记录',exact:true}).click();await expect(page.getByText('下一次相遇，不必等光盘在身边')).toBeVisible();
});

test('minimum window size keeps navigation, playback, and window controls accessible',async({page})=>{
  await page.setViewportSize({width:1000,height:720});await page.goto('/');
  for(const label of ['关闭窗口','最小化','最大化或还原','播放','外观与皮肤'])await expect(page.getByRole('button',{name:label,exact:true})).toBeInViewport();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'artifacts/preview-compact.png'});
});
