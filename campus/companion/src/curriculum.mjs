import {learningPriority} from './learning-progress.mjs';
// Small, authored diagnostic bank. Keys stay outside the model's study and exam prompts.
export const curriculum=[
 {id:'robotics',title:'机器人：刚体与自由度',url:'https://modernrobotics.northwestern.edu/nu-gm-book-resource/2-1-degrees-of-freedom-of-a-rigid-body/',questions:[
  {id:'r1',q:'平面内一个不受约束的刚体有几个自由度？',options:['2','3','6'],key:1,why:'两个平移方向和一个转角。'},
  {id:'r2',q:'空间内一个自由刚体的自由度是多少？',options:['3','5','6'],key:2,why:'三个平移和三个转动自由度。'},
  {id:'r3',q:'用更多坐标描述同一个机构，一定会增加它的自由度吗？',options:['不会，还要考虑独立约束','一定会','自由度等于电机功率'],key:0,why:'坐标表示数量和独立自由度不是一回事。'}]},
 {id:'ai',title:'AI：过拟合与泛化',url:'https://developers.google.com/machine-learning/crash-course/overfitting/overfitting',questions:[
  {id:'a1',q:'训练误差越来越低，验证误差却上升，优先怀疑什么？',options:['模型一定更好了','过拟合','输入全为零'],key:1,why:'模型可能在记忆训练集的特例而非泛化。'},
  {id:'a2',q:'能反复用测试集选择超参数吗？',options:['可以，越多越准','只要不看标签就总可以','不应这样做，应保留独立最终评估'],key:2,why:'选择过程会将测试信息泄漏进模型决策。'},
  {id:'a3',q:'训练效果好是否证明能处理未来所有数据？',options:['是','否','数据多就一定是'],key:1,why:'还需要独立样本和适用范围的验证。'}]},
 {id:'math',title:'数学：导数规则',url:'https://openstax.org/books/calculus-volume-1/pages/3-3-differentiation-rules',questions:[
  {id:'m1',q:'f(x)=x³，在 x=2 处的导数是多少？',options:['6','8','12'],key:2,why:'f′(x)=3x²，所以为12。'},
  {id:'m2',q:'f(x)=5x²−3x+7，f′(1) 是多少？',options:['7','9','10'],key:0,why:'导数是10x−3。'},
  {id:'m3',q:'可导函数 u、v 的乘积导数是哪一项？',options:['u′v′','u′v+uv′','u′+v′'],key:1,why:'乘积法则不是两个导数相乘。'}]},
 {id:'career',title:'职业规划：认识兴趣、能力和价值观',url:'https://capd.mit.edu/channels/self-assessments/',questions:[
  {id:'c1',q:'职业自我评估更应结合什么？',options:['只有热门榜单','兴趣、技能、价值观与现实条件','只有人格测验标签'],key:1,why:'单一标签无法覆盖职业选择的约束。'},
  {id:'c2',q:'不知道是否适合机器人行业，下一步更有信息价值的是？',options:['保证一定适合','凭一篇帖子定终身','做小项目并访谈从业者，更新判断'],key:2,why:'用低成本实践和信息核实修正假设。'},
  {id:'c3',q:'职业测评能否保证具体工作一定合适？',options:['不能，只是探索线索','能保证薪资','能保证录用'],key:0,why:'需要结合实际经历和岗位信息。'}]},
 {id:'language',title:'交流：话题结束、口语与标点',url:'https://www.conversationanalysis.org/schegloff-media-archive/opening-up-closings-1973/',questions:[
  {id:'l1',q:'对方说“晚安，睡了”，哪个回应更贴合当前目的？',options:['晚安～','你想聊什么','请详细解释睡眠意图'],key:0,why:'顺着结束会话，不制造额外服务问题。'},
  {id:'l2',q:'对方说“你好开心”，标点可以怎样处理？',options:['每条固定八个感叹号','随情绪和用户习惯变化','必须每句句号'],key:1,why:'标点是表达线索，不是机械模板；这条是产品偏好题。'},
  {id:'l3',q:'别人明确说一个网络词让他不舒服，应该？',options:['坚持使用才有个性','要求他接受','记住反馈并调整语境用法'],key:2,why:'风格学习应尊重具体听者；不强行套所有人。'}]},
];
export function ensureStudy(s){return s.study??={enabled:true,monthlyLimit:10,lastAttemptDay:null,epoch:0,sessions:[],status:'等待第一次学习'};}
export function chooseLesson(study,now=Math.floor(Date.now()/60000)){
  const latest=study.sessions.filter(x=>x.status==='done').at(-1);
  return [...curriculum].sort((a,b)=>{const score=t=>learningPriority(study,t,now)+(latest?.nextTopic===t.id?0.1:0);return score(b)-score(a);})[0];
}
export function gradeLesson(topic,answers){if(!Array.isArray(answers)||answers.length!==topic.questions.length)throw new Error('考核答案不完整，不能记作通过。');
  const seen=new Set();const details=topic.questions.map(q=>{const a=answers.find(x=>x.id===q.id);if(!a||seen.has(a.id)||!Number.isInteger(a.choice)||a.choice<0||a.choice>=q.options.length)throw new Error('考核答案格式错误。');seen.add(a.id);return {id:q.id,question:q.q,answer:q.options[a.choice],correct:a.choice===q.key,explanation:q.why};});
  return {score:Math.round(details.filter(x=>x.correct).length/details.length*100),details};}
