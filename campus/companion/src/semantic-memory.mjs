import {createHash} from 'node:crypto';
// Recall memories by meaning. "local" runs paraphrase-multilingual-MiniLM-L12-v2 through transformers.js, an
// optional install (npm i @huggingface/transformers, about 300 MB with its ONNX runtime); "api" calls an
// OpenAI-compatible /v1/embeddings endpoint. Whatever is unavailable falls back to lexical recall.
export const LOCAL_MODEL='Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const unit=v=>{let n=0;for(const x of v)n+=x*x;n=Math.sqrt(n)||1;return Float32Array.from(v,x=>x/n);};
export const cosine=(a,b)=>{let d=0;for(let i=0;i<a.length&&i<b.length;i++)d+=a[i]*b[i];return d;};
const digest=text=>createHash('sha256').update(String(text)).digest('hex').slice(0,24);
export class Embedder{
  constructor({config,cacheDir,fetcher=fetch,loadLocal=loadTransformers,clock=Date.now}){Object.assign(this,{config,cacheDir,fetcher,loadLocal,clock,state:'idle',error:'',failedAt:0});}
  model(){const c=this.config();return c.embeddingEngine==='api'&&c.embeddingBase&&c.embeddingModel?'api:'+c.embeddingModel:c.embeddingEngine==='local'?'local:'+LOCAL_MODEL:null;}
  // A failed load is not retried on every message; it waits half an hour.
  usable(){return !!this.model()&&!(this.state==='unavailable'&&this.clock()-this.failedAt<1800000);}
  status(){return {engine:this.config().embeddingEngine,model:this.model(),state:this.model()?this.state:'off',error:this.error};}
  ready(){return this.usable()&&(this.config().embeddingEngine==='api'||!!this.pipe);}
  // The local model may need a first download; it loads in the background and never delays a reply.
  warm(){if(this.config().embeddingEngine!=='local'||this.pipe||this.loading||!this.usable())return;this.state='loading';
    this.loading=this.loadLocal({cacheDir:this.cacheDir,mirror:this.config().embeddingMirror}).then(pipe=>{this.pipe=pipe;this.state='ready';this.error='';},e=>{this.state='unavailable';this.error=String(e.message).slice(0,300);this.failedAt=this.clock();}).finally(()=>{this.loading=null;});}
  async embed(texts){
    const c=this.config();
    try{
      if(c.embeddingEngine==='api'){
        const res=await this.fetcher(new URL(c.embeddingBase).href.replace(/\/+$/,'')+'/v1/embeddings',{method:'POST',headers:{'Content-Type':'application/json',...(c.embeddingKey?{Authorization:'Bearer '+c.embeddingKey}:{})},body:JSON.stringify({model:c.embeddingModel,input:texts}),signal:AbortSignal.timeout(10000)});
        const data=await res.json().catch(()=>({}));if(!res.ok||!Array.isArray(data.data))throw new Error('向量接口返回失败（HTTP '+res.status+'）。');
        this.state='ready';return [...data.data].sort((a,b)=>a.index-b.index).map(d=>unit(d.embedding));
      }
      if(!this.pipe)throw new Error('本地向量模型尚未加载完成。');
      const out=await this.pipe(texts,{pooling:'mean',normalize:true});this.state='ready';return out.tolist().map(v=>Float32Array.from(v));
    }catch(e){this.state='unavailable';this.error=String(e.message).slice(0,300);this.failedAt=this.clock();this.pipe=null;throw e;}
  }
}
async function loadTransformers({cacheDir,mirror}){
  let t;try{t=await import('@huggingface/transformers');}catch{throw new Error('本地向量组件未安装：在项目目录运行 npm i @huggingface/transformers 后重启。');}
  t.env.cacheDir=cacheDir;if(mirror)t.env.remoteHost=mirror.replace(/\/?$/,'/');
  return t.pipeline('feature-extraction',LOCAL_MODEL,{dtype:'q8'});
}
// One vector per memory, keyed by its content hash, so a corrected memory is embedded again.
export class SemanticMemory{
  constructor(db,embedder){Object.assign(this,{db,embedder,last:null});db.exec('CREATE TABLE IF NOT EXISTS memory_vectors(id TEXT PRIMARY KEY,model TEXT NOT NULL,hash TEXT NOT NULL,vector BLOB NOT NULL)');}
  vectors(model){return new Map(this.db.prepare('SELECT id,hash,vector FROM memory_vectors WHERE model=?').all(model).map(r=>[r.id,{hash:r.hash,vector:new Float32Array(new Uint8Array(r.vector).buffer)}]));}
  // Called before a turn is assembled. Never throws: on any failure recall stays lexical for this turn.
  async prepare(query,memories){
    this.last=null;const model=this.embedder.model();if(!query.trim()||!memories.length)return;if(!this.embedder.ready()){this.embedder.warm();return;}
    try{
      const known=this.vectors(model),missing=memories.filter(m=>known.get(m.id)?.hash!==digest(m.content)).slice(0,128);
      for(let i=0;i<missing.length;i+=32){const batch=missing.slice(i,i+32),vectors=await this.embedder.embed(batch.map(m=>m.content));
        const put=this.db.prepare('INSERT OR REPLACE INTO memory_vectors VALUES(?,?,?,?)');batch.forEach((m,k)=>put.run(m.id,model,digest(m.content),Buffer.from(vectors[k].buffer)));}
      const [vector]=await this.embedder.embed([query]);this.last={query,model,vector};
    }catch{this.last=null;}
  }
  similarity(query){
    if(this.last?.query!==query)return null;const {model,vector}=this.last,known=this.vectors(model);
    return m=>{const row=known.get(m.id);return row&&row.hash===digest(m.content)?cosine(row.vector,vector):undefined;};
  }
  purge(){this.db.exec('DELETE FROM memory_vectors');this.last=null;}
}
