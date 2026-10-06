// Optional local resources overlay: never rewrites public JSON or uploads papers.
export async function withLocalResources(catalogue) {
  if (!['cet4','cet6'].includes(catalogue.exam)) return catalogue;
  // Public static hosting keeps its original external resources and notices.
  if (!['localhost','127.0.0.1'].includes(location.hostname)) return catalogue;
  try {
    const response=await fetch(`/api/exam-resources?exam=${catalogue.exam}`,{signal:AbortSignal.timeout(2000)});
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return catalogue;
    const local=await response.json();
    for (const session of catalogue.sessions) for (const set of session.sets) {
      const found=local.sets[set.id];
      if (found) {
        set.resources={...found,...Object.fromEntries(Object.entries(set.resources||{}).filter(([,value])=>value))};
        set.note=set.note ? `${set.note} · 含本机资料` : '本机资料，未公开上传';
      }
    }
  } catch { /* Optional backend absent: preserve the existing static catalogue. */ }
  return catalogue;
}
