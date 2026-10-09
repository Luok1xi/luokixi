// Collections are metadata views. Original files and their versions are never rewritten.
export const BUNDLE_SCHEMA_VERSION = 1;
export const MATERIAL_ROLES = Object.freeze(['paper', 'answer', 'audio', 'other']);
const CET_KEY = /^(cet[46])_(\d{4})_(0[1-9]|1[0-2])_([123](?:-[123])?)$/;
const ROLE_KIND = { '试卷': ['paper'], '原卷': ['paper'], '试卷与答案': ['paper', 'answer'], '答案解析': ['answer'], '答案': ['answer'], '听力音频': ['audio'], '听力': ['audio'] };
const text = (value) => String(value ?? '').trim();
const identity = (item, index = 0) => text(item.url) || text(item.id) || `anonymous-${index}`;

export function parseExamGroup(value) {
  const match = CET_KEY.exec(text(value));
  if (!match) return null;
  const [first, last] = match[4].split('-').map(Number);
  if (last !== undefined && last <= first) return null;
  return { key: match[0], exam: match[1], year: Number(match[2]), month: Number(match[3]), set: match[4] };
}

export function materialRoles(item) {
  const role = text(item.role || item.attachmentRole);
  if (role === 'paper-answer') return ['paper', 'answer'];
  if (MATERIAL_ROLES.includes(role)) return [role];
  return ROLE_KIND[text(item.kind)] || ['other'];
}

function compatibleExam(item, exam) {
  const course = text(item.course);
  const expected = exam.exam === 'cet6' ? ['英语六级', '大学英语六级', 'cet6', 'CET6', 'CET-6'] : ['英语四级', '大学英语四级', 'cet4', 'CET4', 'CET-4'];
  return (!course || expected.includes(course)) && (!text(item.year) || text(item.year) === String(exam.year));
}

// Manifest members use exact document IDs and optional byte hashes, never title similarity.
function manifestAssignments(items, manifest) {
  const claims = new Map();
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.collections)) return claims;
  const ids = new Map(items.filter((item) => item.id).map((item) => [String(item.id), item]));
  const duplicateIds = new Set();
  const seen = new Set();
  for (const entry of manifest.collections) {
    if (!entry || entry.verified !== true || !text(entry.id) || !text(entry.title) || !text(entry.source) || !Array.isArray(entry.members)) continue;
    if (seen.has(entry.id)) duplicateIds.add(entry.id);
    seen.add(entry.id);
    const matched = entry.members.map((member) => ({ member, item: ids.get(String(member.id)) })).filter(({ member, item }) => item && (!member.sha256 || member.sha256 === item.sha256));
    const unique = (key) => new Set(matched.map(({ item }) => text(item[key])).filter(Boolean));
    if (['course', 'courseId', 'year', 'version', 'offeringId'].some((key) => unique(key).size > 1)) continue;
    if (entry.course && [...unique('course')].some((value) => value !== entry.course)) continue;
    if (entry.courseId && [...unique('courseId')].some((value) => value !== entry.courseId)) continue;
    for (const { member, item } of matched) {
      const key = identity(item);
      const list = claims.get(key) || [];
      list.push({ entry, member }); claims.set(key, list);
    }
  }
  for (const [key, claim] of claims) {
    if (claim.length !== 1 || duplicateIds.has(claim[0].entry.id)) claims.delete(key);
    else claims.set(key, claim[0]);
  }
  return claims;
}

/** Stable shelf entries. Files with unknown/conflicting identities remain individual books. */
export function groupMaterialBundles(items, { manifest } = {}) {
  const originals = Array.isArray(items) ? items.filter((item) => item && (!item.status || item.status === 'ready' || item.status === 'published')) : [];
  const assignments = manifestAssignments(originals, manifest);
  const groups = new Map();
  originals.forEach((item, index) => {
    const manifestItem = assignments.get(identity(item, index));
    let exam = parseExamGroup(item.group_key || item.groupKey);
    if (exam && !compatibleExam(item, exam)) exam = null;
    const partition = JSON.stringify([text(item.courseId || item.course_id || item.course), text(item.version), text(item.offeringId || item.offering_id)]);
    const key = manifestItem ? `collection:${manifestItem.entry.id}` : exam ? `suite:${exam.key}:${partition}` : `file:${identity(item, index)}`;
    if (!groups.has(key)) groups.set(key, { item, exam, manifest: manifestItem?.entry, parts: [] });
    groups.get(key).parts.push({ item, member: manifestItem?.member, index });
  });
  return [...groups.entries()].map(([key, group]) => {
    const seen = new Set();
    const parts = group.parts.filter(({ item, index }) => { const id = identity(item, index); if (seen.has(id)) return false; seen.add(id); return true; });
    const rank = (part) => MATERIAL_ROLES.indexOf(materialRoles(part.member ? { ...part.item, role: part.member.role } : part.item)[0]);
    parts.sort((a, b) => (group.manifest ? (Number(a.member?.order) || 0) - (Number(b.member?.order) || 0) : rank(a) - rank(b)) || text(a.item.id || a.item.url).localeCompare(text(b.item.id || b.item.url)));
    const files = parts.map(({ item, member }) => member ? { ...item, role: member.role || '', chapter: member.chapter || '', order: member.order ?? 0 } : item);
    const roles = Object.fromEntries(MATERIAL_ROLES.map((role) => [role, files.filter((item) => materialRoles(item).includes(role))]));
    const isSuite = !!group.exam;
    const missingRoles = isSuite ? ['paper', 'answer', 'audio'].filter((role) => !roles[role].length) : [];
    const primary = roles.paper[0] || files[0];
    const exam = group.exam;
    const title = group.manifest?.title || (exam ? `${exam.exam === 'cet6' ? '英语六级' : '英语四级'} ${exam.year}年${exam.month}月 · 第${exam.set}套${exam.set.includes('-') ? '合集' : ''}` : primary.title);
    return { ...primary, id: key, title, course: group.manifest?.course || primary.course || (exam ? (exam.exam === 'cet6' ? '英语六级' : '英语四级') : ''), courseId: group.manifest?.courseId || primary.courseId || primary.course_id || '', year: exam ? String(exam.year) : primary.year, kind: isSuite ? '套卷' : group.manifest ? '资料合集' : primary.kind, files, roles, fileCount: files.length, missingRoles, groupKey: exam?.key || '', isSuite, isCollection: isSuite || !!group.manifest, complete: isSuite ? missingRoles.length === 0 : null, grouping: group.manifest ? 'verified-manifest' : exam ? 'exact-group-key' : 'individual', collectionId: group.manifest?.id || '', pages: files.filter((file) => file.format === 'pdf').reduce((sum, file) => sum + (Number(file.pages) || 0), 0) };
  });
}
