// Official sources checked 2026-10-06; live inventory and booking remain at the university.
export function campusServiceHTML(use, campus) {
  const library = use === 'library', sports = use === 'sports', teaching = use === 'teaching';
  if (!library && !sports && !teaching) return '';
  const url = library ? 'https://lib.cumtb.edu.cn/' : sports ? 'https://tiyu.cumtb.edu.cn/xwzx/cgyy.htm' : 'https://jwc.cumtb.edu.cn/';
  const title = library ? '图书馆 · 座位与借阅' : sports ? '体育场馆 · 预约指南' : '教室 · 上课与使用';
  const note = library ? '从图书馆官网进入对应校区的座位预约。需学校账号，部分功能限校园网。' : sports ? '按官方指引，在“矿大北京体育服务号”选择场馆与场次，由你确认预约。' : '可以把课程添加到这栋楼。空闲教室与在线预约尚未接入，借用流程请向教务部门核对。';
  return `<section class="atlas-service"><span class="atlas-status">官方服务</span><h3>${title}</h3><p>${note}</p><a class="btn btn-primary btn-sm" href="${url}" target="_blank" rel="noopener">${library ? '前往官网预约' : sports ? '查看预约入口' : '教务信息'} ↗</a>${library?`<a class="btn btn-secondary btn-sm" href="reservations.html?campus=${campus === 'shahe' ? 'shahe' : 'xueyuanlu'}">座位预约助手 →</a>`:''}<small>实时余量未接入 · 信息入口核对于 2026-10-06</small></section>`;
}
