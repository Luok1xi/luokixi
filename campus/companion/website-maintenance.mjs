import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';

export const maintenanceInstruction=`你已获站主授权维护本站。先用 campus_maintenance_read 读取真实资料，再用 campus_maintenance 执行。记住返回的 id，超时先查 action_status，不盲目重发。
维护参数：inventory 无参数；content_list 可用 id/state/kind；project_read 用 repository；code_read 用 paths（从 inventory.robots.source 选择）；code_status/action_status/job_status 用 id；skills 列出已评估和安装技能。
run_robot 用 kind/reason，返回 id 是任务编号，用 job_status{id} 查该任务的真实结果；actionId 是发起操作编号，action_status 的 done 只表示发起操作结束，不等于任务成功。review_content 用 id/revision/state/decision(approve或reject)/reason；edit_content 用 id/revision/state/data/ reason；withdraw_content、restore_content 用 id/revision/state/reason。上下架保留原件。
curate_project 用 repository/beforeHash/shelf(practical,creative,potential,unlisted)/category/reason/checks:{sourceRead,licenseChecked,downloadsChecked}；检查必须依据读到的资料，不乱勾。
code_candidate 用 files:[{path,beforeHash,content}]，随后 code_test{id}，测试通过再 code_apply{id}，失败则阅读结果改正；code_rollback{id} 回退。权限、模型、预算和记忆不能改。
studio_status 查看真实工作室任务、断点、阻塞、凭据和可编辑的工作室代码；同样使用 code_read→code_candidate→code_test→code_apply 自动更新，下一轮生效。studio_module_save 用 id/title/instructions/acceptance(验收标准数组)/enabled 添加任务模块；修改已有模块须附 beforeHash。模块自动加入后续任务契约，只定义工作步骤和验收，不授予额外权限，不需要站主替你复制文件。先读现有模块，避免重复添加。
skill_review 用 repository/commit(完整40位提交号)/path(SKILL.md路径)/licensePath；阅读返回正文和许可，评估与现有工具是否兼容；skill_install 用 id/assessment/ licenseAccepted:true。只安装操作文档，不运行陌生安装脚本。
需要新工具时先 tools{query} 查适配目录，自己判断是否解决当前问题；tool_install{id,assessment} 会真实下载、校验并试运行，通过才启用，无须再请站主确认。tool_run{id,text} 调用 Markdown 阅读器；tool_run{id,documentId} 检查资料库 PDF。失败用 tools 查询原因，别反复空谈。目录外项目先查官方文档、许可和依赖；tools.adapterSource 是可编辑的适配文件，通过 code_read 读取后走 code_candidate→code_test→code_apply，扩展 RECIPES 和 PROBE。这里支持 PyPI 通用 Python wheel，依赖版本需完整固定，其他安装形式先说明缺口。新适配下一次工具调用生效，仍要 tool_install 真实测试，失败不能当作已经学会。记录试验的输入、结果、耗时和未解决点。
discuss 用 goal/reason 找搭档，只有确实需要她的判断才讨论。能调用工具直接解决的事先做，拿真实结果再交接。不把排队、建议和失败说成完成。`;

export function mountMaintenance(app,rpc){
  const taskContext=new AsyncLocalStorage();
  app.agent.withContentTask=(id,fn)=>taskContext.run(id,fn);
  const call=body=>rpc({...body,contentTask:taskContext.getStore()});
  const read=['inventory','content_list','project_read','code_read','code_status','action_status','job_status','skills','tools','studio_status'];
  const write=['run_robot','review_content','edit_content','withdraw_content','restore_content','curate_project','code_candidate','code_test','code_apply','code_rollback','skill_review','skill_install','tool_install','tool_run','discuss','studio_module_save'];
  app.registry.group('maintenance',{title:'网站自主维护与技能扩展',state:'on'});
  for(const [name,operations,risk] of [['campus_maintenance_read',read,'read'],['campus_maintenance',write,'publish']]){
    app.registry.register({name,group:'maintenance',risk,
      description:risk==='read'?'读取真实机器人效率、内容、项目、业务源码、候选测试和技能安装记录。':'站主已授权的机器人维护、测试应用、技能安装、内容编辑上下架和搭档协作。参数规则见维护说明；不需要再问站主批准。',
      parameters:{operation:{type:'string',enum:operations},arguments:{type:'object'},requestId:{type:'string',description:'重查同一操作使用返回的 id；新操作可省略，由程序生成。'}},required:['operation','arguments'],
      handler:async({operation,arguments:args,requestId})=>{if(!operations.includes(operation))throw new Error('维护操作不匹配。');
        const id=risk==='read'?undefined:requestId||randomUUID();try{const result=await call({op:'maintenance',operation,arguments:args,id});return risk==='read'?result:{...result,actionId:id};}
        catch(e){throw new Error(e.message+(id?'；操作编号 '+id+'，先查 action_status。':'；这是读取请求，请核对参数后重试。'));}}
    });
  }
  // The authorization comes from the private server policy, never from a skill document.
  app.agent.maintenancePolicy=()=>app.service.store.read().websiteWork?.observation?.maintenance?.enabled===true;
  app.agent.maintenanceInstruction=maintenanceInstruction;
  const key={type:'string',description:'先搜索得到的内容编号，例如 entry/UUID、featured/编号、github/作者/仓库、page/site'};
  const invoke=async(operation,args)=>{
    const id=['content_publish','content_review'].includes(operation)?randomUUID():undefined;
    // Retry only when every field in the patch still matches its pre-edit value.
    try{return {...await call({op:'maintenance',operation,arguments:args,id}),...(id?{actionId:id}: {})};}
    catch(e){
      if(operation==='content_publish'&&args.before&&/版本.*变化|内容已更新/.test(e.message)){
        const latest=await call({op:'maintenance',operation:'content_read',arguments:{key:args.key}});
        const fields=Object.keys(args.patch||{});
        if(fields.every(k=>JSON.stringify(latest.data[k])===JSON.stringify(args.before[k]))){
          const retryId=randomUUID();return {...await call({op:'maintenance',operation,arguments:{...args,revision:latest.revision},id:retryId}),actionId:retryId,retried:true};
        }
      }
      throw new Error(e.message+(id?'；操作编号 '+id+'。先查 action_status，不重复写入。':''));
    }
  };
  const definitions=[
    ['content_search','read','搜索网站文章、待审校圈、新闻、项目、公告和页面说明。',{query:{type:'string'},state:{type:'string'},kind:{type:'string'}},[]],
    ['content_read','read','读取目标正文、来源、配图、状态及当前版本。',{key},['key']],
    ['content_history','read','查看修改者、历史版本和修改说明。',{key},['key']],
    ['content_publish','publish','修改并立即发布，成功回执 completed=true。先读取版本与原值；仅写需要改动的字段。',{key,revision:{type:'integer'},patch:{type:'object'},before:{type:'object'},reason:{type:'string'},locationChecked:{type:'boolean'},supervisorQuestionsResolved:{type:'boolean'}},['key','revision','patch','reason']],
    ['content_review','publish','审核待审内容，通过或退回；必须基于正文、来源和图片核对。',{key,revision:{type:'integer'},decision:{type:'string',enum:['approve','reject']},reason:{type:'string'},locationChecked:{type:'boolean'},supervisorQuestionsResolved:{type:'boolean'}},['key','revision','decision','reason']],
    ['content_task','read','按编号查询这次聊天任务的进度和真实结果。',{id:{type:'string'}},['id']],
  ];
  for(const [name,risk,description,parameters,required] of definitions)app.registry.register({name,group:'maintenance',risk,description,parameters,required,handler:args=>invoke(name,args)});
  app.agent.maintenanceInstruction+='\n内容操作优先用 content_search→content_read→content_publish 或 content_review。搜索可以按标题和 pending 状态定位校圈测试。不要凭记忆重复旧故障；注明旧记录时间，读取当前状态。未返回 completed=true 不得声称已发布。content_publish 的 before 为修改字段的原值，非冲突修改最多自动重试一次。';
}
