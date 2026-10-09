import {writeFileSync} from 'node:fs';
import {characterCard} from './src/character-card.mjs';
const headings={identity:'你是谁',personality:'性格与反应',voice:'说话方式',care:'和人的相处',self:'自我与感受',interests:'兴趣与梗',lore:'形象与背景'};
writeFileSync(new URL('./roles/小煤渣.md',import.meta.url),'# 角色卡：小煤渣 · 北矿娘\n\n'+Object.entries(headings).map(([key,title])=>'## '+title+'\n\n'+characterCard[key]).join('\n\n')+'\n','utf8');
