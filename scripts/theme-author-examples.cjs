// Regenerate the three installable starter examples using the app's export path.
const fs = require('node:fs');
const path = require('node:path');
const { mobileRequire, loadSharp, createNodeImageDecoder } = require('./lib/theme-package-node.cjs');
mobileRequire('tsx/cjs');
const { buildAuthoredTheme } = require('../android-app/apps/mobile/melo/theme-author.ts');
const { builtInThemes } = require('../android-app/apps/mobile/melo/core/theme.ts');
const { licenseExample } = require('./lib/theme-example-license.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'theme-packages/starter-examples');
const art = {modern:'coast',pastoral:'meadow',anime:'orbit'};
(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const sharp=loadSharp();
  for(const [base,name] of Object.entries(art)) {
    const theme=builtInThemes[base];
    const overlay=await sharp({create:{width:720,height:1280,channels:4,background:theme.tokens.surface.base+'cc'}}).png().toBuffer();
    const background=await sharp(path.join(root,`android-app/apps/mobile/melo/assets/${name}.png`)).resize(720,1280,{fit:'cover',position:'centre'}).composite([{input:overlay}]).png().toBuffer();
    const result=await buildAuthoredTheme({base,name:theme.name+'样例',background},createNodeImageDecoder(sharp));
    const target=path.join(output,base+'.melotheme');
    fs.writeFileSync(target,await licenseExample(result.bytes));
    console.log(`${base}: validated, ${result.bytes.length} bytes`);
    if (base === 'modern') {
      // Original simple geometry, rasterized once at authoring time.
      const thumb = await sharp(Buffer.from('<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="27" fill="#315A86"/><circle cx="32" cy="32" r="10" fill="#FFFDF9"/></svg>')).png().toBuffer();
      const advanced = await buildAuthoredTheme({base,name:'独立进度条样例',background,progress:{colors:{track:'#DDD8D1',fill:'#C3483B',thumb:'#315A86'},thumbImage:thumb}},createNodeImageDecoder(sharp));
      const licensed = await licenseExample(advanced.bytes);
      fs.writeFileSync(path.join(output,'modern-custom-progress.melotheme'),licensed);
      const JSZip=mobileRequire('jszip');
      const zip=await JSZip.loadAsync(licensed);
      const sourceRoot=path.join(root,'theme-packages/progress-example');
      fs.mkdirSync(sourceRoot,{recursive:true});
      const manifest=JSON.parse(await zip.file('manifest.json').async('string'));
      const images={};
      for(const asset of manifest.assets) {
        images[asset.path]=asset.path;
        const file=path.join(sourceRoot,asset.path);
        fs.mkdirSync(path.dirname(file),{recursive:true});
        fs.writeFileSync(file,await zip.file(asset.path).async('nodebuffer'));
      }
      delete manifest.assets;
      manifest.id='example.custom-progress';
      for(const filename of ['tokens.json','components.json','LICENSE.txt']) fs.writeFileSync(path.join(sourceRoot,filename),await zip.file(filename).async('string'));
      fs.writeFileSync(path.join(sourceRoot,'source.json'),JSON.stringify({manifest,images},null,2)+'\n');
      console.log(`custom progress: validated, ${advanced.bytes.length} bytes`);
    }
  }
})().catch(error=>{console.error(error);process.exitCode=1});
