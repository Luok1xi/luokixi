let pending;
export async function applyEditorial(name,data){
  pending??=fetch('/api/hub/management/overlays',{credentials:'same-origin',signal:AbortSignal.timeout(4000)})
    .then(r=>r.ok?r.json():{items:{}}).catch(()=>({items:{}}));
  const {items={}}=await pending;if(!data)return data;
  const output={...data,...items['page/'+name]};
  if(name==='featured'&&Array.isArray(output.items))output.items=output.items.map(row=>({...row,...items['featured/'+row.id]}));
  return output;
}
