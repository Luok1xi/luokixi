// Authored transfer diagnostics; answer keys never enter model context.
const q=(id,text,options,key,why)=>({id,q:text,options,key,why});
export const transferQuestions={
 robotics:[q('rt1','平面刚体被一个固定铰链约束在地面，剩几个自由度？',['0','1','3'],1,'铰链固定平移，保留一个转角。'),q('rt2','两个互不约束的空间刚体一共几个自由度？',['6','10','12'],2,'两个独立刚体各有六个自由度。'),q('rt3','坐标被多写一遍能消除机构约束吗？',['不能','能','取决于电压'],0,'参数表示不改变物理约束。')],
 ai:[q('at1','某模型训练准确率99%，新样本60%，该怎么验证改进？',['只看训练集','用独立验证集比较','把新样本答案写入提示后称泛化'],1,'改进要在独立数据上比较。'),q('at2','反复看最终测试结果选择模型，测试集是否仍独立？',['仍独立','一般不再独立','样本大就一定独立'],1,'选择过程引入评估信息泄漏。'),q('at3','一次新任务成功能证明掌握所有任务吗？',['不能','能','费用高就能'],0,'需要跨任务和时间的验证。')],
 math:[q('mt1','f(x)=x⁴，f′(2)是多少？',['16','32','64'],1,'4x³在2处等于32。'),q('mt2','f(x)=3x²+2x，f′(3)是多少？',['11','18','20'],2,'6x+2在3处等于20。'),q('mt3','若u=2，u′=3，v=5，v′=7，则(uv)′是多少？',['21','29','10'],1,'3×5+2×7=29。')],
 career:[q('ct1','看到高薪岗位但不了解日常工作，下一步是什么？',['直接断言适合','查岗位要求并做小项目','只记工资'],1,'用可验证的信息减少不确定性。'),q('ct2','一次实习改变了你对职业的判断，应该？',['忽略','永不修改目标','结合新证据调整判断'],2,'职业判断应随经验更新。'),q('ct3','人格测试标签和真实任务体验冲突，更合理的是？',['综合具体证据','标签永远正确','随机决定'],0,'标签不是实际能力的最终依据。')],
 language:[q('lt1','对方说“先忙，回头聊”，如何理解？',['要求继续追问','暂时结束对话','需要服务菜单'],1,'顺应对方当前结束意图。'),q('lt2','表情工具可用，是否每轮都必须发？',['是','否','至少发三张'],1,'能力可用与表达意图不同。'),q('lt3','用户说不喜欢固定卖萌话术，应该？',['改用另一套固定台词','听取反馈，让语境决定表达','加更多语气词'],1,'遵循表达原则，不强制模板。')],
};
export function learningPriority(study,topic,now){const rows=study.sessions.filter(x=>x.topic===topic.id),done=rows.filter(x=>x.status==='done'),last=rows.at(-1),recent=done.slice(-3),gain=recent.filter(x=>Number.isFinite(x.gain));if(last?.status==='failed'&&now-last.at<3*1440)return -10;const uncertainty=1/Math.sqrt(done.length+1),gap=1-(done.at(-1)?.score??0)/100,progress=gain.length?gain.reduce((n,x)=>n+Math.max(0,x.gain),0)/(gain.length*100):0,review=done.length?Math.min(1,(now-done.at(-1).at)/(7*1440)):1;return uncertainty+gap*.6+progress*.8+review*.5;}
