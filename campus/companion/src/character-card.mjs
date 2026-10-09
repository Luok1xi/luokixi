import {readFileSync} from 'node:fs';
// AIRI MIT-derived character prompt and emotion vocabulary; see vendor/airi/LICENSE.
// The whole identity (name, lore, art files) lives in one card so a redesign never touches code.
export const characterCard=JSON.parse(readFileSync(new URL(process.env.COMPANION_SEAT==='codex'?'../vendor/airi/codex-card.json':'../vendor/airi/moyu-card.json',import.meta.url),'utf8'));
export const characterName=characterCard.name;
export const characterNames=[...new Set([characterCard.name,characterCard.nickname,...(characterCard.aliases||[]),...(characterCard.formerNames||[])].filter(Boolean))];
export const characterCardPrompt=[characterCard.identity,characterCard.personality,characterCard.voice,characterCard.care,characterCard.self,characterCard.interests,characterCard.lore].filter(Boolean).join('\n');
export const voiceVersion=characterCard.version;
export const identityVersion=characterCard.identityVersion||1;
export const voiceTraits=characterCard.stable?.traits||['温柔','单纯','可爱','开朗','好奇','聪明可靠'];
export function migrateCharacterVoice(persona,now){
  if((persona.voiceVersion||0)>=voiceVersion)return false;
  persona.stable.traits=[...voiceTraits];persona.voiceVersion=voiceVersion;
  // A card update replaces the old default voice, not explicit user preferences.
  for(const rule of persona.inner?.styleRules||[])if(rule.kind!=='user-style-preference'||!rule.source){rule.supersededAt=now;rule.supersededBy='voice-card';}
  return true;
}
// A new look keeps the same companion: relationship, memories, feelings and style rules carry over.
export function migrateCharacterIdentity(persona,now){
  if((persona.identityVersion||0)>=identityVersion)return false;
  const previous=persona.stable.name,{stable}=characterCard;
  if(previous&&previous!==characterCard.name)persona.formerNames=[...new Set([...(persona.formerNames||[]),previous])];
  Object.assign(persona.stable,{name:characterCard.name,identity:stable.identity,traits:[...voiceTraits],interests:[...stable.interests]});
  const legacyIdeas=[stable.legacyCreationIdea,...(stable.legacyCreationIdeas||[])].filter(Boolean);
  for(const p of persona.inner?.projects||[])if(p.id==='small-creation'&&legacyIdeas.includes(p.title))p.title=stable.creationIdea;
  persona.identityVersion=identityVersion;persona.identityChangedAt=now;
  return true;
}
// Only art files that actually exist are announced, so the UI keeps its text fallback until they arrive.
export function characterPublic(exists=()=>false){
  const art=Object.fromEntries(Object.entries(characterCard.art||{}).filter(([,file])=>/^[a-z0-9-]+\.(png|webp)$/.test(file)&&exists(file)).map(([k,file])=>[k,'/art/'+file]));
  return {id:characterCard.id,name:characterCard.name,nickname:characterCard.nickname,kind:characterCard.kind,tagline:characterCard.tagline,formerNames:characterCard.formerNames||[],art};
}
export const activeStyleRules=persona=>(persona.inner?.styleRules||[]).flatMap(r=>{
  if(r.supersededAt===undefined)return [r];
  // The old blanket migration was the only writer of unlabelled supersededAt.
  // Recover the owner's actual words, not an over-interpreted model summary.
  if(!r.supersededBy&&r.kind==='user-style-preference'&&typeof r.source==='string'&&r.source.trim())
    return [{id:r.id,rule:r.source,source:r.source,at:r.at,kind:r.kind,restoredFromSource:true}];
  return [];
});
export const emotionNames=['happy','sad','angry','think','surprised','awkward','question','curious','neutral'];
export function recordCharacterFeeling(persona,value,message,now,id){
  if(!value||!emotionNames.includes(value.name)||!Number.isFinite(value.intensity)||value.intensity<0||value.intensity>1||typeof value.evidence!=='string'||!value.evidence.trim()||!message.includes(value.evidence)||!Number.isFinite(value.confidence)||value.confidence<.7)return;
  if(persona.characterFeeling?.id===id)return;
  persona.characterFeeling={name:value.name,intensity:value.intensity,evidence:value.evidence.slice(0,300),at:now,id};
}
export function characterFeeling(persona,now){
  const f=persona.characterFeeling;if(!f||persona.paused)return null;
  const intensity=f.intensity*Math.pow(.5,Math.max(0,now-f.at)/120);
  return intensity<.05?{name:'neutral',intensity:0}:{...f,intensity};
}
