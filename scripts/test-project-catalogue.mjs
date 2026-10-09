import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allCuratedProjects, mergeDiscoveryCards, mergeProjects, projectIdentity, publicProjectEntries } from '../src/js/project-catalogue.js';

const seed = (slug, repository) => ({ slug, title: `static ${slug}`, summary: 'manual summary', category: 'mech', origin: 'external', credit: 'original author', links: { repo: `https://github.com/${repository}` }, repo: { fullName: repository, stars: 120 }, cover: 'manual.webp' });
const entry = (id, repository, extra = {}) => ({ id, slug: id, kind: 'project', revision: 2, owner: { id: 12, name: 'Member' }, data: { title: `approved ${id}`, summary: 'approved summary', links: { repo: `https://github.com/${repository}` }, category: 'embedded', license: 'MIT' }, ...extra });
const curated = repository => ({ repository, repositoryUrl: `https://github.com/${repository}`, title: 'curated', idea: 'curated summary', entryId: 'curated-id', sections: [{ heading: 'Reviewed guide', text: 'guide' }], downloads: [{ name: 'upstream.zip' }], guideState: 'reviewed' });

test('one reviewed project enriches its static card and preserves all other real projects', () => {
  const merged = mergeProjects([seed('robot', 'Artist/Robot'), seed('other', 'other/tool')], [entry('published', 'artist/robot.git/')]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].title, 'approved published');
  assert.equal(merged[0].summary, 'approved summary');
  assert.equal(merged[0].cover, 'manual.webp');
  assert.equal(merged[0].repo.stars, 120);
  assert.equal(merged[0].publicRevision, 2);
  assert.equal(merged[1].title, 'static other');
});

test('only approved data is used for authors, staff, draft/pending/rejected revisions', () => {
  for (const state of ['published', 'draft', 'pending', 'rejected']) {
    const p = entry('published', 'author/tool', { state, draft: { title: 'SECRET pending', links: { repo: 'https://github.com/SECRET/new' } }, editRevision: 3 });
    const result = mergeProjects([], [p]);
    assert.equal(result[0].title, 'approved published');
    assert.equal(result[0].links.repo, 'https://github.com/author/tool');
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
  assert.deepEqual(mergeProjects([], [entry('pending-first', 'author/new', { revision: 0 }), entry('withdrawn', 'author/old', { state: 'withdrawn' })]), []);
});

test('same entry revisions deduplicate; slug or owner collisions do not overwrite different projects', () => {
  const old = entry('same', 'author/tool', { revision: 1 });
  const newer = entry('same', 'author/tool', { revision: 3, data: { ...old.data, title: 'approved revision three' } });
  const other = entry('different', 'other/tool', { slug: 'same', owner: old.owner });
  const result = mergeProjects([seed('same', 'third/tool')], [old, newer, other]);
  assert.equal(result.length, 3);
  assert.equal(result[1].title, 'approved revision three');
});

test('unions curated cards with static and published projects, preserving approved text and reviewed guide', () => {
  const cards = [{ ...seed('robot', 'artist/robot'), repositoryUrl: 'https://github.com/artist/robot', repository: 'artist/robot', publicRevision: 2, entryId: 'approved', idea: 'approved summary', siteStars: 7 }, { ...seed('other', 'other/tool'), repositoryUrl: 'https://github.com/other/tool', repository: 'other/tool' }];
  const result = mergeDiscoveryCards(cards, [curated('Artist/Robot'), curated('new/project')]);
  assert.equal(result.length, 3);
  assert.equal(result[0].entryId, 'approved');
  assert.equal(result[0].idea, 'approved summary');
  assert.equal(result[0].category, 'mech');
  assert.equal(result[0].sections[0].heading, 'Reviewed guide');
  assert.equal(result[0].downloads.length, 1);
});

test('not-interested excludes the same repository from curated and catalogue sources', () => {
  const card = { ...seed('hidden', 'author/Tool'), repositoryUrl: 'https://github.com/author/Tool' };
  assert.deepEqual(mergeDiscoveryCards([card], [curated('author/tool')], ['AUTHOR/TOOL']), []);
});

test('public projects fetch every page, never fetch drafts, and terminate if a page becomes empty', async () => {
  const calls = [];
  const items = Array.from({ length: 35 }, (_, n) => entry(String(n), `author/tool${n}`));
  const api = { catalogue: async filters => { calls.push(filters); return { total: items.length, items: items.slice(filters.offset, filters.offset + 30) }; } };
  assert.equal((await publicProjectEntries(api)).length, 35);
  assert.deepEqual(calls, [{ kind: 'project', offset: 0 }, { kind: 'project', offset: 30 }]);
  assert.deepEqual(await publicProjectEntries({ catalogue: async () => ({ total: 99, items: [] }) }), []);
});

test('curated projects read every cursor once and retain private exclusions across pages', async () => {
  const calls = [];
  const result = await allCuratedProjects({ feed: async ({ cursor }) => { calls.push(cursor); return cursor ? { items: [curated('last/tool')], nextCursor: null } : { items: [curated('first/tool')], nextCursor: 'page2', ignoredRepositories: ['hidden/tool'] }; } });
  assert.deepEqual(calls, [null, 'page2']);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.ignoredRepositories, ['hidden/tool']);
  await assert.rejects(allCuratedProjects({ feed: async () => ({ items: [], nextCursor: 'repeated' }) }), /分页/);
});

test('repository normalization is case insensitive for GitHub and never collapses separate repos', () => {
  assert.equal(projectIdentity(seed('a', 'AUTHOR/Tool.git')), projectIdentity(seed('b', 'author/tool')));
  assert.notEqual(projectIdentity(seed('a', 'author/tool')), projectIdentity(seed('a', 'other/tool')));
});

test('later network failures keep pages already read from public and curated sources', async () => {
  const errors = [];
  const items = await publicProjectEntries({ catalogue: async ({ offset }) => { if (offset) throw Error('page two offline'); return { total: 2, items: [entry('one', 'author/one')] }; } }, error => errors.push(error.message));
  assert.equal(items.length, 1);
  const selected = await allCuratedProjects({ feed: async ({ cursor }) => { if (cursor) throw Error('cursor offline'); return { items: [curated('author/one')], nextCursor: 'next', ignoredRepositories: ['hidden/tool'] }; } }, error => errors.push(error.message));
  assert.equal(selected.items.length, 1);
  assert.deepEqual(selected.ignoredRepositories, ['hidden/tool']);
  assert.deepEqual(errors, ['page two offline', 'cursor offline']);
});

test('local hiding also works for a project without a GitHub repository', () => {
  const card = { repository: 'site-only-project', entryId: 'site-entry', repositoryUrl: 'https://demo.example.test/app', title: 'Demo' };
  assert.deepEqual(mergeDiscoveryCards([card], [], ['site-only-project']), []);
});

test('fresh selected stars for the same published identity survive catalogue caching', () => {
  const approved = { repositoryUrl:'https://github.com/author/tool',entryId:'same',publicRevision:2,title:'Approved',idea:'Approved Chinese summary',ideaLanguage:'zh',license:'MIT',credit:'Author',starred:false,siteStars:0 };
  const selected = { ...curated('author/tool'),entryId:'same',starred:true,siteStars:1,ideaLanguage:'original',license:'cached license' };
  const result = mergeDiscoveryCards([approved],[selected])[0];
  assert.equal(result.starred,true);
  assert.equal(result.siteStars,1);
  assert.equal(result.ideaLanguage,'zh');
  assert.equal(result.license,'MIT');
});

test('switching shelves stops remaining stale cursor requests', async () => {
  let calls = 0;
  const result = await allCuratedProjects({ feed: async () => { calls++; return { items: [curated('author/one')], nextCursor: 'next' }; } }, undefined, () => false);
  assert.equal(calls, 1);
  assert.equal(result.items.length, 1);
});
