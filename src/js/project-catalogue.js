// Public project data only. Editing and review payloads never participate in this catalogue.
export function repositoryName(value) {
  try {
    const u = new URL(value);
    if (u.hostname.toLowerCase() !== 'github.com') return null;
    const parts = u.pathname.replace(/\/+$/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
    return parts.length === 2 ? parts.join('/') : null;
  } catch { return null; }
}

export function projectIdentity(p) {
  const repo = p.links?.repo || p.repositoryUrl || (p.repo?.fullName ? `https://github.com/${p.repo.fullName}` : '');
  if (repo) {
    const name = repositoryName(repo);
    if (name) return `github:${name.toLowerCase()}`;
    try {
      const u = new URL(repo);
      u.hash = ''; u.search = ''; u.pathname = u.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
      return `repo:${u.href}`;
    } catch { /* Use the stable content identity below. */ }
  }
  if (p.entryId) return `entry:${p.entryId}`;
  return `slug:${p.ownerId ?? ''}:${p.slug ?? p.repository}`;
}

export function publishedProject(entry) {
  if (entry.kind !== 'project' || !(entry.revision > 0) || entry.state === 'withdrawn') return null;
  const data = entry.data ?? {};
  const fullName = repositoryName(data.links?.repo);
  return {
    ...data, slug: entry.slug, entryId: entry.id, publicRevision: entry.revision,
    ownerId: entry.owner?.id, owner: entry.owner, pageUrl: `project.html?id=${encodeURIComponent(entry.id)}`,
    origin: entry.owner?.campusVerified ? 'cumtb' : 'external',
    originLabel: entry.owner ? '本站投稿' : '外部推荐',
    credit: data.credit || entry.owner?.name || fullName?.split('/')[0] || '站内投稿',
    authors: [], links: data.links ?? {},
    repo: fullName ? { fullName, license: data.license || null } : null,
    siteStars: entry.siteStars ?? 0, starred: Boolean(entry.starred),
  };
}

export function mergeProjects(staticProjects, entries) {
  const projects = new Map(staticProjects.map(p => [projectIdentity(p), { ...p }]));
  const seen = new Map();
  for (const entry of entries) {
    const p = publishedProject(entry);
    if (!p) continue;
    const key = projectIdentity(p), previous = seen.get(key);
    // API order chooses the public representative of duplicate submissions. For the same
    // entry, a later public revision wins; neither owner nor slug can override a different repo.
    if (previous && (previous.entryId !== p.entryId || previous.publicRevision >= p.publicRevision)) continue;
    const seed = projects.get(key);
    projects.set(key, {
      ...seed, ...p,
      origin: seed?.origin ?? p.origin,
      originLabel: seed ? undefined : p.originLabel,
      authors: seed?.authors ?? p.authors,
      links: { ...seed?.links, ...p.links },
      repo: seed?.repo || p.repo ? { ...seed?.repo, ...p.repo } : null,
      cover: p.cover || seed?.cover, coverCredit: p.coverCredit || seed?.coverCredit,
    });
    seen.set(key, p);
  }
  return [...projects.values()];
}

export async function publicProjectEntries(api, onError) {
  const entries = [];
  let offset = 0;
  while (true) {
    let page;
    try { page = await api.catalogue({ kind: 'project', offset }); }
    catch (error) { if (!onError) throw error; onError(error); return entries; }
    entries.push(...page.items);
    offset += page.items.length;
    if (!page.items.length || offset >= page.total) return entries;
  }
}

export async function allCuratedProjects(api, onError, shouldContinue = () => true) {
  const items = [], ignoredRepositories = new Set(), cursors = new Set();
  let cursor = null;
  do {
    let page;
    try { page = await api.feed({ shelf: 'all', cursor }); }
    catch (error) { if (!onError) throw error; onError(error); break; }
    items.push(...page.items);
    for (const repository of page.ignoredRepositories ?? []) ignoredRepositories.add(repository);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('项目分页已变化，请刷新重试。');
    cursors.add(cursor);
  } while (cursor && shouldContinue());
  return { items, ignoredRepositories: [...ignoredRepositories] };
}

export function mergeDiscoveryCards(catalogue, curated, ignored = []) {
  const blocked = new Set(ignored.map(repository => projectIdentity({ repositoryUrl: `https://github.com/${repository}` })));
  const blockedNames = new Set(ignored);
  const cards = new Map();
  for (const card of curated) {
    const key = projectIdentity(card);
    if (!blocked.has(key) && !blockedNames.has(card.repository)) cards.set(key, card);
  }
  for (const card of catalogue) {
    const key = projectIdentity(card), selected = cards.get(key);
    if (blocked.has(key) || blockedNames.has(card.repository)) continue;
    if (!selected) { cards.set(key, card); continue; }
    cards.set(key, {
      ...card, ...selected,
      // Curated guide/download fields enrich the card; approved community text remains authoritative.
      title: card.publicRevision ? card.title : selected.title,
      idea: card.publicRevision ? card.idea : selected.idea || card.idea,
      ideaLanguage: card.publicRevision ? card.ideaLanguage : selected.ideaLanguage,
      license: card.publicRevision ? card.license : selected.license || card.license,
      credit: card.publicRevision ? card.credit : selected.credit || card.credit,
      category: card.category || selected.category,
      entryId: card.entryId || selected.entryId,
      siteStars: selected.entryId && selected.entryId === card.entryId ? selected.siteStars : card.entryId ? card.siteStars : selected.siteStars,
      starred: selected.entryId && selected.entryId === card.entryId ? selected.starred : card.entryId ? card.starred : selected.starred,
      cover: card.cover || selected.cover, coverCredit: card.coverCredit || selected.coverCredit,
    });
  }
  return [...cards.values()];
}
