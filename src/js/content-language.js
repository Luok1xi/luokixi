// Do not overwrite authored or upstream text. Chinese is the default reading
// surface; originals stay available for comparison instead of being discarded.
export function chinesePresentation(data,guide){
 if(!data?.links?.repo)return data;
 const original={};const next={...data};
 for(const key of ['summary','body','setup','needs','hardware']){
  if(typeof data[key]!=='string'||!data[key].trim()||/[\u3400-\u9fff]/.test(data[key]))continue;
  original[key]=data[key];next[key]=key==='summary'?(guide?.oneLiner||'中文导读正在整理，可查看来源原文与本站文件。'):'';
 }
 return Object.keys(original).length?{...next,sourceLanguage:original}:data;
}
