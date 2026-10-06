import {build} from 'vite';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
await build({configFile:false,root,publicDir:false,logLevel:'warn',build:{
  outDir:resolve(root,'campus/.data/community-qa/client'),emptyOutDir:false,minify:false,
  lib:{entry:{adapter:resolve(root,'campus/community-client.js'),notebook:resolve(root,'src/js/community-notebook.js')},formats:['es'],fileName:(_format,name)=>name+'.js'},
}});
console.log('Built isolated community adapter modules.');
