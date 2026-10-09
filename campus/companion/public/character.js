// Display identity comes from the server's character card (bootstrap.character); the defaults only cover the first paint.
export const character={id:'moyu',name:'小煤渣',nickname:'煤渣',kind:'北矿娘 · 校园守灯人',tagline:'校园不大，梗装得下。',formerNames:['Miku','墨玉'],art:{}};
export const setCharacter=value=>Object.assign(character,value||{});
export function renderCharacter(){
  document.title=character.name+' · 陪伴工作室';
  document.querySelectorAll('[data-character-name]').forEach(node=>node.textContent=character.name);
  document.querySelectorAll('[data-character-tagline]').forEach(node=>node.textContent=character.tagline);
  if(document.querySelector('#chat')?.classList.contains('active'))document.querySelector('#page-title').textContent='和 '+character.name+' 说说话';
  const avatar=document.querySelector('#character-avatar'),portrait=document.querySelector('#character-portrait');
  const safeArt=path=>typeof path==='string'&&/^\/art\/[a-z0-9-]+\.(png|webp)$/.test(path);
  if(avatar&&safeArt(character.art.avatar)&&avatar.dataset.src!==character.art.avatar){
    const img=document.createElement('img');img.src=character.art.avatar;img.alt=character.name;
    img.onerror=()=>{avatar.textContent=character.name.slice(0,1);};
    avatar.replaceChildren(img);avatar.dataset.src=character.art.avatar;
  }
  if(portrait&&safeArt(character.art.portrait)){
    const img=portrait.querySelector('img');
    if(img.getAttribute('src')!==character.art.portrait){img.src=character.art.portrait;img.onerror=()=>{portrait.hidden=true;};}
    portrait.hidden=false;
  }
}
