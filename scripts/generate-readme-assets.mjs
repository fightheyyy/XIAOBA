import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';

// Render the shipped PetPlayer so static README artwork follows the product.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'assets');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'desktop/dashboard/pets/xiaoba/pet.json'), 'utf8'));
await fs.mkdir(assets, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.XIAOBA_CHROMIUM_PATH ? { executablePath: process.env.XIAOBA_CHROMIUM_PATH } : {}),
  headless: true,
});

try {
  const page = await browser.newPage({ viewport: { width: 384, height: 416 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<!doctype html><html><meta charset="utf-8"><body style="margin:0;background:transparent"><canvas width="768" height="832" style="width:384px;height:416px"></canvas></body></html>');
  await page.addScriptTag({ path: path.join(root, 'desktop/dashboard/grokbot-data.js') });
  await page.addScriptTag({ path: path.join(root, 'desktop/dashboard/pet-runtime.js') });
  await page.evaluate(manifest => {
    window.player = new window.XiaoBaPetRuntime.PetPlayer(document.querySelector('canvas'));
    window.player.load(manifest, { autoplay: false });
    window.player.reducedMotion = true;
    window.player.draw();
  }, manifest);
  for (const dark of [false, true]) {
    await page.evaluate(dark => {
      const base = window.player.getTheme();
      window.player.setColors(base.body, base.eyes, dark ? base.eyes : null);
    }, dark);
    const png = await page.screenshot({ omitBackground: true });
    await sharp(png).trim().resize(480, 480, { fit: 'contain', background: '#00000000' })
      .extend({ top: 16, right: 16, bottom: 16, left: 16, background: '#00000000' })
      .png().toFile(path.join(assets, dark ? 'xiaoba-logo-dark.png' : 'xiaoba-logo.png'));
  }

  await page.setViewportSize({ width: 1280, height: 310 });
  await page.evaluate(manifest => {
    document.body.style.cssText = 'margin:0;background:#fff;color:#29343c;font-family:Arial,sans-serif';
    document.body.innerHTML = `<div style="box-sizing:border-box;padding:36px 32px 24px;background:#f8f7f3;border-radius:24px;height:310px">
      <div style="font-size:24px;font-weight:650;letter-spacing:-.5px;margin:0 20px">One main agent. Eight specialists.</div>
      <div id="roles" style="display:grid;grid-template-columns:repeat(9,1fr);margin-top:10px"></div></div>`;
    const roles = [
      ['base','Base','Conversation'], ['engineer-cat','EngineerCat','Code'],
      ['browser-cat','BrowserCat','Browser'], ['gui-cat','GuiCat','Desktop'],
      ['secretary-cat','SecretaryCat','Feishu'], ['user-cat','UserCat','Explore'],
      ['inspector-cat','InspectorCat','Inspect'], ['reviewer-cat','ReviewerCat','Evaluate'],
      ['evolution-cat','EvolutionCat','Memory & skills'],
    ];
    for (const [role, name, job] of roles) {
      const item = document.createElement('div');item.style = 'text-align:center';
      const canvas = document.createElement('canvas');canvas.width = 260;canvas.height = 282;
      canvas.style = 'width:130px;height:141px';item.append(canvas);
      const label = document.createElement('div');label.textContent = name;label.style = 'font-size:13px;font-weight:600';item.append(label);
      const caption = document.createElement('div');caption.textContent = job;caption.style = 'font-size:11px;color:#758078;margin-top:7px';item.append(caption);
      document.getElementById('roles').append(item);
      const player = new window.XiaoBaPetRuntime.PetPlayer(canvas);player.load(manifest, { role, autoplay: false });
      player.reducedMotion = true;player.draw();
    }
  }, manifest);
  await page.screenshot({ path: path.join(assets, 'readme-roles.png'), scale: 'css' });
  if (errors.length) throw new Error(errors.join('\n'));
  for (const filename of ['xiaoba-logo.png', 'xiaoba-logo-dark.png', 'readme-roles.png']) {
    const { size } = await fs.stat(path.join(assets, filename));
    console.log(`${filename}: ${(size / 1024).toFixed(0)} KiB`);
  }
} finally {
  await browser.close();
}
