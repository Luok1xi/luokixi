import"./modulepreload-polyfill-P2Xu9kJm.js";import{a as e,r as t}from"./data-Dv5cexaq.js";import{r as n,t as r}from"./shell-CeC3ZAUd.js";import{t as i}from"./library-Zr-c6AkA.js";r();var a=(e,t=document)=>t.querySelector(e),o=(e,t=document)=>[...t.querySelectorAll(e)],s={"calc-a1":`∫`,"calc-a2":`∬`,linalg:`λ`},c=[`期末`,`课程考卷`,`期中`,`扫描试卷`,`扫描合集`],l=e=>Number(e.year.match(/\d{4}/)?.[0]??0);function u(e){let n=[e.hasAnswers?`<span class="tag tag-ok">含答案</span>`:``,e.scanned?`<span class="tag">扫描件</span>`:``,`<span class="tag">${e.pages} 页</span>`].join(``);return`<li class="paper-row">
    <span class="paper-year">${t(e.year)}<small>${t(e.stage)}</small></span>
    <div>
      <p class="paper-title">${t(e.kind)}</p>
      <div class="paper-tags">${n}</div>
    </div>
    <a class="btn btn-secondary btn-sm" href="${t(e.file)}" target="_blank" rel="noopener">打开</a>
  </li>`}function d(e){let n={courses:e.courses.length,papers:e.papers.length,answers:e.papers.filter(e=>e.hasAnswers).length};o(`[data-school-stat]`).forEach(e=>e.textContent=n[e.dataset.schoolStat]),a(`#course-list`).innerHTML=e.courses.map((n,r)=>{let i=e.papers.filter(e=>e.course===n.id).sort((e,t)=>l(t)-l(e)||c.indexOf(e.stage)-c.indexOf(t.stage)),a=i.filter(e=>e.hasAnswers).length;return`<section class="lib-year" id="${n.id}">
        <div class="wrap lib-year-grid">
          <header class="lib-year-side">
            <div class="course-head" data-reveal style="--hue:${r*-50}deg">
              <span class="course-glyph" aria-hidden="true">${s[n.id]??`∑`}</span>
            </div>
            <h2 class="session-title" data-reveal>${t(n.name)}</h2>
            <p class="lib-year-meta" data-reveal>${i.length} 份试卷${a?` · ${a} 份附答案`:``}</p>
          </header>
          <div class="paper-list-wrap" data-reveal>
            <ul class="paper-list" role="list">${i.map(u).join(``)}</ul>
          </div>
        </div>
      </section>`}).join(``);let r=a(`#jumpbar`);r.insertAdjacentHTML(`beforeend`,e.courses.map(e=>`<a href="#${e.id}">${t(e.name)}</a>`).join(``)),i(r)}e(`school`).then(e=>{d(e),n(),location.hash&&document.getElementById(location.hash.slice(1))?.scrollIntoView()}).catch(e=>{console.error(`[luokixi] 校内资料加载失败`,e),a(`#course-list`).innerHTML=`<p class="wrap notice">资料目录暂时加载不出来，请稍后刷新重试。</p>`});