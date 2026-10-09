// Publish only the original, validated local sticker collection to the website.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {stickers} from './src/message-chain.mjs';
const target=new URL('../../public/art/beikuang/stickers/',import.meta.url);
await mkdir(target,{recursive:true});
const items=[];
for(const sticker of stickers){
  if(!/^[a-z0-9_]+\.png$/.test(sticker.file))continue;
  const bytes=await readFile(new URL('public/stickers/'+sticker.file,import.meta.url));
  if(bytes.length>1000000||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Invalid original sticker: '+sticker.id);
  await writeFile(new URL(sticker.file,target),bytes);
  items.push({id:sticker.id,label:sticker.label,url:'/art/beikuang/stickers/'+sticker.file});
}
await writeFile(new URL('catalogue.json',target),JSON.stringify({source:'campus-companion original collection',items}));
console.log('Original stickers available: '+items.length);
