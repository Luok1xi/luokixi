import {clockText,dateMinute} from './time.mjs';

export function lifeContext(state,now){
  const breakfast=state.settings.breakfastHabit||{start:'08:00',end:'09:00',confirmed:false};
  const clock=clockText(now);
  return {breakfast:{...breakfast,inWindow:clock>=breakfast.start&&clock<breakfast.end,
    source:breakfast.confirmed?'用户在作息设置中明确填写':'用户举出的生活情境参考，并非已确认的个人习惯'},
    guidance:'生活规律用于理解情境，不用于自动催促。早餐窗口不代表已经吃过、没吃或饿了；不要求每天询问。上课、赶路、起晚、用户明确说过的状态优先。默认课表中的用餐占位不证明真实作息。聊私人关系时保留多种解释，不根据一句话断定对方动机，也不替用户回复别人。'};
}

export function saveBreakfastHabit(settings,args){
  const start=args.start,end=args.end;
  if(typeof start!=='string'||typeof end!=='string')throw Error('请填写早餐开始和结束时间。');
  dateMinute('2026-01-01',start);dateMinute('2026-01-01',end);
  if(start>=end)throw Error('早餐习惯的结束时间应晚于开始时间。');
  settings.breakfastHabit={start,end,confirmed:true};
}
