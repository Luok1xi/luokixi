// Stable IDs preserve every utterance across polling and never replay history on mount.
export class StagePlayback {
  constructor(){this.seen=new Set();this.read=new Set();this.lines=[];this.pending=[];this.current=null;this.started=false;}
  ingest(lines,{initial=false}={}){
    // Polling can return a shorter window. Never discard this session's backlog.
    const known=new Map(this.lines.map(l=>[l.id,l]));for(const line of lines)known.set(line.id,line);this.lines=[...known.values()];
    if(!this.started){this.started=true;for(const line of lines){this.seen.add(line.id);this.read.add(line.id);}this.current=lines.at(-1)||null;return [];}
    const fresh=[];
    for(const line of lines)if(!this.seen.has(line.id)){this.seen.add(line.id);this.pending.push(line);fresh.push(line);}
    return fresh;
  }
  next(){const line=this.pending.shift();if(line){this.current=line;this.read.add(line.id);}return line;}
  get history(){return this.lines.filter(l=>this.read.has(l.id));}
  skip(){for(const line of this.pending)this.read.add(line.id);this.pending=[];this.current=this.lines.at(-1)||null;return this.current;}
}
// Punctuation grouping and paced ink adapted from the owner's game textbox.js.
const segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter('zh',{granularity:'grapheme'}):null;
export function dialogueGlyphs(text,speed=18){
  const chars=segmenter?[...segmenter.segment(text)].map(s=>s.segment):[...text];
  const groups=[];let time=0,open=null;
  for(const char of chars){
    const item={char,delay:time};
    if('，。、！？；：…—）」』”’》〉.,!?;:)~～'.includes(char)&&groups.length)groups.at(-1).push(item);
    else if(open){open.push(item);open=null;}else{const group=[item];groups.push(group);if('（「『“‘《〈('.includes(char))open=group;}
    time+=speed*('。！？!?'.includes(char)?4:'，、；：'.includes(char)?2.2:1);
  }
  // Scale a long utterance's whole timeline instead of dumping its remaining
  // characters together at the 2.6s cap. Punctuation keeps its relative pause.
  const pace=Math.min(1,2600/Math.max(time,1));
  if(pace<1)for(const group of groups)for(const item of group)item.delay=Math.round(item.delay*pace);
  return {groups,duration:Math.min(time,2600)+180};
}

// Keep the paced ink, but never create one DOM node / animation per character.
// Native inline wrapping handles punctuation and long words without nested nowrap spans.
export function dialogueRuns(text,speed=18){
  const {groups,duration}=dialogueGlyphs(text,speed),runs=[];
  const batch=Math.max(2,Math.ceil(groups.length/24));
  for(let i=0;i<groups.length;i+=batch){
    const items=groups.slice(i,i+batch).flat();
    runs.push({text:items.map(item=>item.char).join(''),delay:items[0].delay});
  }
  return {runs,duration};
}
