import {esc} from './data.js';
import '../styles/journal-expression.css';
const moods={neutral:'平静',happy:'有点开心',sad:'有点低落',angry:'不太高兴',think:'还在琢磨',awkward:'有点不好意思',surprised:'意料之外',curious:'想继续研究',question:'还有疑问',composed:'心里有数',sleepy:'有点困了'};
export function journalExpression(data){
 const expression=data?.journalExpression;if(!expression)return '';
 const name=expression.seat==='codex'?'Codex':'北矿娘',avatar=expression.seat==='codex'?'/art/companions/codex-avatar-v1.png':'/art/beikuang/avatar.png';
 const mood=expression.messages?.find(m=>m.expression&&m.expression!=='neutral')?.expression;
 return `<p class="journal-expression"><img src="${avatar}" alt="" width="40" height="40" loading="lazy" decoding="async"><span>${name}${moods[mood]?` · ${esc(moods[mood])}`:''}</span></p>`;
}
