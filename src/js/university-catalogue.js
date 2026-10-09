// Catalogue metadata only. A downloaded file or extracted paragraph is not a question bank.
export const UNIVERSITY_PAGE_SIZE = 12;
export const BANK_PAGE_SIZE = 16;
export const COMPOSE_LIMIT = 200;
export const UNIVERSITY_KINDS = { exam:'试卷', answer:'答案', exercise:'习题', notes:'笔记 / 讲义', unknown:'待分类' };
export const UNIVERSITY_PHASES = { indexed:'已发现', downloaded:'有原件', extracted:'已取正文', structured:'可选题组卷', 'needs-review':'待核对' };
const text = (value) => typeof value === 'string' ? value : '';
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const known = (value) => value && value !== 'unknown' && value !== '未分类' ? String(value) : '';
const list = (value) => Array.isArray(value) ? value : [];

export function normalizeUniversityCatalogue(raw = {}) {
  const schools = list(raw.schools).filter(s => s && s.id).map(s => ({ ...s, id:String(s.id), name:text(s.name) || String(s.id), groups:[...new Set(list(s.groups).flatMap(g => g === 'strong-non-211' ? ['strong-non-211','specialist'] : [String(g)]))] }));
  const schoolMap = new Map(schools.map(s => [s.id,s]));
  const sources = list(raw.sources).filter(s => s && s.id);
  const sourceMap = new Map(sources.map(s => [String(s.id),s]));
  const banks = list(raw.questionBanks).filter(b => b && b.id && count(b.questionCount || b.questions?.length)).map(b => ({ ...b, id:String(b.id), questionCount:count(b.questionCount || b.questions?.length) }));
  const bankMap = new Map(banks.map(b => [b.id,b]));
  const seen = new Set();
  const resources = list(raw.resources).filter(r => {
    if (!r || !r.id || seen.has(String(r.id))) return false;
    seen.add(String(r.id)); return true;
  }).map(r => {
    const school = schoolMap.get(String(r.schoolId));
    const source = sourceMap.get(String(r.sourceId));
    const bank = bankMap.get(String(r.bankId));
    const course = known(r.course), year = /^(19|20)\d{2}$/.test(String(r.year)) ? String(r.year) : '';
    const kind = Object.hasOwn(UNIVERSITY_KINDS, r.kind) ? r.kind : 'unknown';
    const phase = bank ? 'structured' : r.state === 'needs-review' ? 'needs-review' : r.state === 'extracted' ? 'extracted' : r.state === 'downloaded' ? 'downloaded' : 'indexed';
    const hasOriginal = Boolean(r.hasOriginal === true || ['downloaded','extracted'].includes(r.state) || r.downloadedAt || r.downloadedPath || r.sha256);
    const item = { ...r, id:String(r.id), schoolId:school?.id || text(r.schoolId), schoolName:school?.name || '学校待核实', groups:school?.groups || [], sourceName:text(source?.name), course, year, kind, phase, hasOriginal, bankId:bank?.id || '', questionCount:bank?.questionCount || 0, checkedAt:r.checkedAt || source?.checkedAt || r.indexedAt || '', sourceStatus:source?.status || '', sourceFailure:source?.error || source?.failureReason || '', title:text(r.title) || text(r.path).split('/').pop() || '未命名资料', url:text(r.url), sourceUrl:text(r.sourceUrl || source?.url), evidence:list(r.classificationEvidence) };
    item.searchText = [item.schoolName, ...item.groups, school?.aliases?.join?.(' '), school?.id, item.sourceName, item.course, item.year, UNIVERSITY_KINDS[kind], text(r.path), ...list(r.knowledgePoints)].filter(Boolean).join(' ');
    return item;
  });
  // A structured bank can exist before its original file enters the resource index.
  for (const bank of banks) {
    if (resources.some(r => r.bankId === bank.id)) continue;
    const school = schoolMap.get(String(bank.schoolId));
    const source = sourceMap.get(String(bank.sourceId));
    resources.push({ id:`bank:${bank.id}`, bankId:bank.id, schoolId:school?.id || text(bank.schoolId), schoolName:school?.name || text(bank.schoolName) || '开放资料', groups:school?.groups || [], title:text(bank.title) || '来源题册', course:known(bank.course), year:'', kind:'exercise', phase:'structured', questionCount:bank.questionCount, sourceName:text(source?.name), sourceStatus:source?.status || '', sourceFailure:source?.error || '', checkedAt:bank.checkedAt || source?.checkedAt || '', url:text(bank.sourceUrl), sourceUrl:text(bank.sourceUrl), evidence:[], searchText:[bank.title,school?.name,school?.aliases?.join?.(' '),bank.course].filter(Boolean).join(' ') });
  }
  return { schools, sources, banks, bankMap, resources, generatedAt:text(raw.generatedAt), failures:list(raw.failures), runStats:raw.runStats || {}, version:raw.version };
}

export function filterUniversityResources(resources, filters = {}) {
  return resources.filter(r => (!filters.group || filters.group === 'all' || r.groups.includes(filters.group)) && (!filters.school || r.schoolId === filters.school) && (!filters.course || (filters.course === '__unknown' ? !r.course : r.course === filters.course)) && (!filters.year || (filters.year === '__unknown' ? !r.year : r.year === filters.year)) && (!filters.kind || r.kind === filters.kind) && (!filters.phase || (filters.phase === 'downloaded' ? r.hasOriginal : r.phase === filters.phase)));
}

export function universityCounts(resources) {
  const schoolIds = new Set(resources.map(r => r.schoolId).filter(Boolean));
  const bankIds = new Set();
  let original = 0, questions = 0;
  for (const row of resources) {
    if (row.hasOriginal) original++;
    if (row.bankId && !bankIds.has(row.bankId)) { bankIds.add(row.bankId); questions += count(row.questionCount); }
  }
  return { resources:resources.length, schools:schoolIds.size, originals:original, banks:bankIds.size, questions };
}

export function selectionPayload(selections) {
  const questionIds = [];
  const bankIds = [];
  for (const [bankId, ids] of selections) {
    if (!ids.size) continue;
    bankIds.push(bankId);
    for (const questionId of ids) questionIds.push({ bankId, questionId });
  }
  return { bankIds, questionIds };
}
