import {BaseCheckpointSaver,copyCheckpoint,WRITES_IDX_MAP} from '@langchain/langgraph-checkpoint';

// LangGraph's checkpoint contract on the runtime's existing Node SQLite connection.
// This avoids a second native SQLite binary on Windows and keeps checkpoints in the
// same per-character private database as the execution journal, never in process RAM.
export class WebsiteCheckpointer extends BaseCheckpointSaver{
  constructor(db){super();this.db=db;
    db.exec(`CREATE TABLE IF NOT EXISTS website_graph_checkpoints(
      thread_id TEXT NOT NULL, namespace TEXT NOT NULL, id TEXT NOT NULL, parent TEXT,
      type TEXT NOT NULL, checkpoint BLOB NOT NULL, metadata_type TEXT NOT NULL, metadata BLOB NOT NULL,
      PRIMARY KEY(thread_id,namespace,id));
      CREATE TABLE IF NOT EXISTS website_graph_writes(
      thread_id TEXT NOT NULL, namespace TEXT NOT NULL, checkpoint_id TEXT NOT NULL, task_id TEXT NOT NULL,
      idx INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT NOT NULL, value BLOB NOT NULL,
      PRIMARY KEY(thread_id,namespace,checkpoint_id,task_id,idx));`);
  }
  scope(config,requireCheckpoint=false){const c=config?.configurable||{};
    if(!c.thread_id||requireCheckpoint&&!c.checkpoint_id)throw new Error('持久工作流缺少任务或断点编号。');
    return [c.thread_id,c.checkpoint_ns||'',c.checkpoint_id];}
  async tuple(row){
    const pending=this.db.prepare('SELECT task_id,channel,type,value FROM website_graph_writes WHERE thread_id=? AND namespace=? AND checkpoint_id=? ORDER BY task_id,idx')
      .all(row.thread_id,row.namespace,row.id);
    const config={configurable:{thread_id:row.thread_id,checkpoint_ns:row.namespace,checkpoint_id:row.id}};
    return {config,checkpoint:await this.serde.loadsTyped(row.type,row.checkpoint),
      metadata:await this.serde.loadsTyped(row.metadata_type,row.metadata),
      parentConfig:row.parent?{configurable:{thread_id:row.thread_id,checkpoint_ns:row.namespace,checkpoint_id:row.parent}}:undefined,
      pendingWrites:await Promise.all(pending.map(async r=>[r.task_id,r.channel,await this.serde.loadsTyped(r.type,r.value)]))};
  }
  async getTuple(config){const [thread,namespace,id]=this.scope(config);
    const row=id?this.db.prepare('SELECT * FROM website_graph_checkpoints WHERE thread_id=? AND namespace=? AND id=?').get(thread,namespace,id)
      :this.db.prepare('SELECT * FROM website_graph_checkpoints WHERE thread_id=? AND namespace=? ORDER BY id DESC LIMIT 1').get(thread,namespace);
    return row?this.tuple(row):undefined;
  }
  async *list(config,options={}){
    const clauses=[],args=[],c=config?.configurable||{};
    for(const [column,value] of [['thread_id',c.thread_id],['namespace',c.checkpoint_ns]])if(value!==undefined){clauses.push(column+'=?');args.push(value);}
    if(options.before?.configurable?.checkpoint_id){clauses.push('id<?');args.push(options.before.configurable.checkpoint_id);}
    const rows=this.db.prepare('SELECT * FROM website_graph_checkpoints'+(clauses.length?' WHERE '+clauses.join(' AND '):'')+' ORDER BY id DESC').all(...args);
    let count=0;
    for(const row of rows){const tuple=await this.tuple(row);
      if(options.filter&&!Object.entries(options.filter).every(([k,v])=>JSON.stringify(tuple.metadata?.[k])===JSON.stringify(v)))continue;
      if(options.limit!==undefined&&count>=options.limit)break;
      count++;yield tuple;
    }
  }
  async put(config,checkpoint,metadata){const [thread,namespace,parent]=this.scope(config);
    const [[type,data],[metadataType,metadataData]]=await Promise.all([this.serde.dumpsTyped(copyCheckpoint(checkpoint)),this.serde.dumpsTyped(metadata)]);
    this.db.prepare('INSERT OR REPLACE INTO website_graph_checkpoints VALUES(?,?,?,?,?,?,?,?)')
      .run(thread,namespace,checkpoint.id,parent||null,type,data,metadataType,metadataData);
    return {configurable:{thread_id:thread,checkpoint_ns:namespace,checkpoint_id:checkpoint.id}};
  }
  async putWrites(config,writes,taskId){const [thread,namespace,id]=this.scope(config,true);
    const rows=await Promise.all(writes.map(async([channel,value],idx)=>{
      const [type,data]=await this.serde.dumpsTyped(value);return [thread,namespace,id,taskId,WRITES_IDX_MAP[channel]??idx,channel,type,data];
    }));
    const replace=this.db.prepare('INSERT OR REPLACE INTO website_graph_writes VALUES(?,?,?,?,?,?,?,?)');
    const insert=this.db.prepare('INSERT OR IGNORE INTO website_graph_writes VALUES(?,?,?,?,?,?,?,?)');
    // No awaits inside the transaction; the character store may hold its own transaction.
    this.db.exec('SAVEPOINT website_graph_write');
    try{for(const row of rows)(row[5] in WRITES_IDX_MAP?replace:insert).run(...row);this.db.exec('RELEASE website_graph_write');}
    catch(e){this.db.exec('ROLLBACK TO website_graph_write; RELEASE website_graph_write');throw e;}
  }
  async deleteThread(threadId){this.db.exec('SAVEPOINT website_graph_delete');
    try{this.db.prepare('DELETE FROM website_graph_writes WHERE thread_id=?').run(threadId);
      this.db.prepare('DELETE FROM website_graph_checkpoints WHERE thread_id=?').run(threadId);this.db.exec('RELEASE website_graph_delete');}
    catch(e){this.db.exec('ROLLBACK TO website_graph_delete; RELEASE website_graph_delete');throw e;}
  }
}
