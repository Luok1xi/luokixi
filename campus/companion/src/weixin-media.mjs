import {readFile} from 'node:fs/promises';
import {randomBytes,createHash,createCipheriv} from 'node:crypto';
import {stickers} from './message-chain.mjs';
export function trustedCdn(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||!['novac2c.cdn.weixin.qq.com'].includes(u.hostname))throw new Error('微信图片上传地址不在已核验的 CDN。');return u.href;}
// Tencent iLink protocol: AES-128-ECB/PKCS7, encrypted bytes only to the official CDN.
export async function uploadSticker(weixin,account,id){
 const sticker=stickers.find(s=>s.id===id);if(!sticker)throw new Error('未知表情包。');
 const raw=sticker.downloadId?(await weixin.stickerFile(sticker.downloadId)).bytes:await readFile(new URL('../public/stickers/'+sticker.file,import.meta.url));
 const key=randomBytes(16),cipher=createCipheriv('aes-128-ecb',key,null),encrypted=Buffer.concat([cipher.update(raw),cipher.final()]),filekey=randomBytes(16).toString('hex');
 const out=await weixin.request('ilink/bot/getuploadurl',{account,data:{filekey,media_type:1,to_user_id:account.user,rawsize:raw.length,rawfilemd5:createHash('md5').update(raw).digest('hex'),filesize:encrypted.length,no_need_thumb:true,aeskey:key.toString('hex')}});
 if(!out.upload_full_url&&!out.upload_param)throw new Error('微信未返回图片上传地址。');
 const url=trustedCdn(out.upload_full_url||'https://novac2c.cdn.weixin.qq.com/c2c/upload?'+new URLSearchParams({encrypted_query_param:out.upload_param,filekey}));
 let res;try{res=await weixin.fetcher(url,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:encrypted,redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw new Error('微信表情包上传失败。');}
 const param=res.headers.get('x-encrypted-param');await res.body?.cancel();if(res.status!==200||!param)throw new Error('微信未接受表情包上传。');
 return {type:2,image_item:{media:{encrypt_query_param:param,aes_key:Buffer.from(key.toString('hex')).toString('base64'),encrypt_type:1},mid_size:encrypted.length}};
}
