// A repository owner's avatar is their identity, never the project's or school's logo.
export function projectImage(project, collected) {
  const existing = project.cover || '';
  const generated = !existing || /^(?:\/?art\/|\/api\/hub\/illustration\/)/.test(existing);
  return generated && collected?.image ? {
    ...project, cover: collected.image, coverCredit: collected.credit,
    coverSource: collected.sourceUrl, coverStale: collected.stale,
  } : project;
}
export function institutionIcon(project) {
  const title = String(project.title || '');
  if (/清华|tsinghua/i.test(title)) return { src: 'art/institutions/tsinghua.png', alt: '清华大学官方校名标识', source: 'https://www.tsinghua.edu.cn/' };
  return null;
}
