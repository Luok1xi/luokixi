// Official sources checked 2026-10-06; live inventory and booking remain at the university.
// 结构化的官方服务入口：楼的小窗（地图上点楼时弹出）和楼的详情卡共用同一份数据。
// 只给学校官方入口，不抓取需要登录的系统；实时余量没有接入，界面上要明说。
export const SERVICES_CHECKED = '2026-10-06';

export function campusServices(use, campus) {
  const reserve = `reservations.html?campus=${campus === 'shahe' ? 'shahe' : 'xueyuanlu'}`;
  if (use === 'library')
    return {
      title: '图书馆 · 座位与借阅',
      note: '从图书馆官网进入对应校区的座位预约。需学校账号，部分功能限校园网。',
      actions: [
        { label: '前往官网预约', url: 'https://lib.cumtb.edu.cn/', external: true, primary: true },
        { label: '座位预约助手', url: reserve },
      ],
    };
  if (use === 'sports')
    return {
      title: '体育场馆 · 预约指南',
      note: '按官方指引，在“矿大北京体育服务号”选择场馆与场次，由你确认预约。',
      actions: [{ label: '查看预约入口', url: 'https://tiyu.cumtb.edu.cn/xwzx/cgyy.htm', external: true, primary: true }],
    };
  if (use === 'teaching')
    return {
      title: '教室 · 上课与使用',
      note: '可以把课程添加到这栋楼。空闲教室与在线预约尚未接入，借用流程请向教务部门核对。',
      actions: [{ label: '教务信息', url: 'https://jwc.cumtb.edu.cn/', external: true, primary: true }],
    };
  return null;
}

const actionHTML = (a, small = true) =>
  `<a class="btn ${a.primary ? 'btn-primary' : 'btn-secondary'}${small ? ' btn-sm' : ''}" href="${a.url}"${a.external ? ' target="_blank" rel="noopener"' : ''}>${a.label}${a.external ? ' ↗' : ' →'}</a>`;

export function campusServiceHTML(use, campus) {
  const s = campusServices(use, campus);
  if (!s) return '';
  return `<section class="atlas-service"><span class="atlas-status">官方服务</span><h3>${s.title}</h3><p>${s.note}</p>${s.actions.map((a) => actionHTML(a)).join('')}<small>实时余量未接入 · 信息入口核对于 ${SERVICES_CHECKED}</small></section>`;
}

// 楼的小窗里用的紧凑版本：只有按钮和一行状态
export function campusServiceButtons(use, campus) {
  const s = campusServices(use, campus);
  if (!s) return '';
  return `<div class="mp-pop-actions">${s.actions.map((a) => actionHTML(a)).join('')}</div><p class="mp-pop-note">实时余量未接入 · 入口核对于 ${SERVICES_CHECKED}</p>`;
}
