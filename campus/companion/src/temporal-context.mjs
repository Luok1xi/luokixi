import {dateKey,clockText,stamp,startOfDay,weekday} from './time.mjs';

const weekdays=['周一','周二','周三','周四','周五','周六','周日'];
const valid=t=>Number.isInteger(t)&&t>=0;
const calendarDifference=(a,b)=>(startOfDay(a)-startOfDay(b))/1440;

// Reference-time and precision separation, inspired by Recognizers-Text and Duckling.
// This is clock/context data, not a replacement for semantic interpretation or dialogue.
export function calendarReference(at){
  const monday=startOfDay(at)-(weekday(at)-1)*1440;
  return {at:stamp(at),weekday:weekdays[weekday(at)-1],today:dateKey(at),yesterday:dateKey(at-1440),
    tomorrow:dateKey(at+1440),dayAfterTomorrow:dateKey(at+2880),
    thisWeek:Object.fromEntries(weekdays.map((d,i)=>[d,dateKey(monday+i*1440)])),
    nextWeek:Object.fromEntries(weekdays.map((d,i)=>[d,dateKey(monday+(7+i)*1440)]))};
}

export function datedHistory(rows,now,limit=16){
  return rows.slice(-limit).map(({id,role,text,messages,at})=>({id,role,text,...(messages?{messages}:{}),
    sentAt:valid(at)?stamp(at):null,calendarDaysAgo:valid(at)?calendarDifference(now,at):null,
    elapsedMinutes:valid(at)?now-at:null}));
}

export function temporalContext(now,history=[],referenceAt=now){
  const anchor=valid(referenceAt)&&referenceAt<=now+5?referenceAt:now;
  const lastUser=history.filter(x=>x.role==='user'&&valid(x.at)).at(-1);
  const lastAssistant=history.filter(x=>x.role==='assistant'&&valid(x.at)).at(-1);
  const hour=Number(clockText(now).slice(0,2));
  return {timezone:'Asia/Shanghai',utcOffset:'+08:00',storedInstantUnit:'epoch_minutes',
    now:stamp(now),weekday:weekdays[weekday(now)-1],dayPeriod:hour<6?'凌晨':hour<12?'上午':hour<18?'下午':'晚上',
    reference:calendarReference(anchor),processingDelayMinutes:now-anchor,
    lastUserAt:lastUser?stamp(lastUser.at):null,lastUserElapsedMinutes:lastUser?now-lastUser.at:null,
    calendarDaysSinceLastUser:lastUser?calendarDifference(now,lastUser.at):null,
    lastAssistantAt:lastAssistant?stamp(lastAssistant.at):null};
}

export function timedTask(task,now){
  return {...task,deadlineAt:valid(task.deadline)?stamp(task.deadline):null,
    deadlineStatus:!valid(task.deadline)?'unknown':task.deadline<=now?'overdue':dateKey(task.deadline)===dateKey(now)?'today':'upcoming'};
}

export const temporalPolicy=`时间以 temporal 为准，时区 Asia/Shanghai。当前时间与原消息时间分开：本轮“今天/明天/下周”相对 reference；历史里的相对日期相对该条 sentAt，不能搬到当前日期。已有明确日期不擅自滚到下一周或下一年；跨午夜、跨月、跨年按日历计算。“过一会儿/晚点”没有准确分钟数，不凭空承诺定时发送；“周三之前”等边界不明确时先澄清，不能自行取午夜或全天结束。“还要两小时”可能是剩余工时，不等于两小时后的截止日期。缺失时间视为未知；时间过去不等于任务完成或你持续在线做了事情。聊天隔了几天就保留这个间隔，不把旧事称作刚才或今天；但不用在每句闲聊里报时、复述日期或列日程。`;
