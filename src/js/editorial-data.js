let pending;
export async function applyEditorial(name,data){
  pending??=fetch('/api/hub/management/overlays',{credentials:'same-origin',signal:AbortSignal.timeout(4000)})
    .then(r=>r.ok?r.json():{items:{}}).catch(()=>({items:{}}));
  const {items={}}=await pending;if(!data)return data;
  if(Array.isArray(data))return data;
  const output={...data,...items['page/'+name]};
  if(name==='featured'&&Array.isArray(output.items))output.items=output.items.map(row=>({...row,...items['featured/'+row.id]}));
  if(name==='community'&&Array.isArray(output.projects))output.projects=output.projects.map(row=>{
    const patch=items['github/'+row.repo?.fullName];if(!patch)return row;
    return {...row,...patch,summary:patch.summary??patch.description??row.summary,
      ...(patch.media?.src?{cover:patch.media.src,coverCredit:patch.media.credit,coverSource:patch.media.sourceUrl}: {})};
  });
  return output;
}
