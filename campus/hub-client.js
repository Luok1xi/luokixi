// Headless client for Opus pages. No DOM changes and no requests on static-only hosts.
const localHost = () => ['127.0.0.1', 'localhost'].includes(globalThis.location?.hostname);
const configured = () => import.meta.env?.VITE_CAMPUS_BACKEND === 'same-origin';

export class HubError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'HubError'; this.status = status; }
}

export function createHubClient({ base = '/api/hub', available = localHost() || configured(), fetcher = globalThis.fetch } = {}) {
  let csrf = '';
  const query = values => new URLSearchParams(Object.entries(values).filter(([,v]) => v !== undefined && v !== null && v !== '')).toString();
  const id = value => encodeURIComponent(value);
  async function request(path, body, options = {}) {
    if (!available) throw new HubError('社区服务未连接；当前可以浏览公开目录。', 503);
    const mutate = body !== undefined;
    if (mutate && !csrf) await session();
    const multipart = typeof FormData !== 'undefined' && body instanceof FormData;
    let response;
    try {
      response = await fetcher(`${base}/${path}`, {
        credentials: 'same-origin', ...options,
        ...(mutate ? { method: 'POST', headers: { 'X-CSRFToken': csrf, ...(multipart ? {} : { 'Content-Type': 'application/json' }) },
          body: multipart ? body : JSON.stringify(body) } : {}),
      });
    } catch { throw new HubError('社区服务暂时无法连接，请稍后重试。', 503); }
    let value;
    try { value = await response.json(); }
    catch { throw new HubError('社区服务未连接或返回格式不正确。', 503); }
    if (!response.ok) throw new HubError(value.error || `请求失败 (${response.status})`, response.status);
    if (value.csrfToken) csrf = value.csrfToken;
    return value;
  }
  const session = () => request('auth/session');
  const entryAction = (entry, action, body) => request(`entries/${id(entry)}/${action}`, body);
  return {
    available, request, session,
    health: () => request('health'),
    register: data => request('auth/register', data), login: data => request('auth/login', data),
    logout: () => request('auth/logout', {}), me: () => request('me'),
    updateProfile: data => request('auth/profile', data),
    categories: () => request('categories'), recommendations: () => request('recommendations'),
    teachers: (filters = {}) => request(`teachers?${query(filters)}`), teacher: key => request(`teachers/${id(key)}`),
    courses: (filters = {}) => request(`courses?${query(filters)}`), course: key => request(`courses/${id(key)}`),
    offering: key => request(`offerings/${id(key)}`),
    reviews: (filters = {}) => request(`reviews?${query(filters)}`), courseReview: key => request(`reviews/${id(key)}`),
    myReviews: () => request('reviews/mine'), reviewModeration: () => request('reviews/moderation'),
    submitReview: data => request('reviews', data),
    saveReview: (key, revision, data) => request(`reviews/${id(key)}/save`, { revision, data }),
    moderateReview: (key, revision, decision, note) => request(`reviews/${id(key)}/moderate`, { revision, decision, note }),
    withdrawReview: (key, reason) => request(`reviews/${id(key)}/withdraw`, { reason }),
    likeReview: (key, enabled) => request(`reviews/${id(key)}/like`, { enabled }),
    replyToReview: (key, body, anonymous = true) => request(`reviews/${id(key)}/replies`, { body, anonymous }),
    moderateReviewReply: (key, decision, note) => request(`review-replies/${id(key)}/moderate`, { decision, note }),
    withdrawReviewReply: key => request(`review-replies/${id(key)}/withdraw`, {}),
    reportReview: (key, reason) => request(`reviews/${id(key)}/report`, { reason }),
    appealReview: (key, reason) => request(`reviews/${id(key)}/appeal`, { reason }),
    resolveReviewCase: (key, resolution) => request(`review-cases/${id(key)}/resolve`, { resolution }),
    saveReputationCatalogue: (kind, data) => request(kind, data),
    clipCapabilities: () => request('clips/capabilities'),
    clips: (filters = {}) => request(`clips?${query(filters)}`),
    myClips: () => request('clips/mine'), moderateClips: () => request('clips/moderation'),
    uploadClip: (file, fields) => { const data = new FormData(); data.append('file', file); for (const [key, value] of Object.entries(fields)) data.append(key, String(value)); return request('clips', data); },
    moderateClip: (key, decision, note) => request(`clips/${id(key)}/moderate`, { decision, note }),
    withdrawClip: (key, note) => request(`clips/${id(key)}/withdraw`, { note }),
    places: (filters = {}) => request(`map/places?${query(filters)}`),
    observePlace: (entry, status, note = '') => request(`map/places/${id(entry)}/observe`, { status, note }),
    sendVerification: () => request('auth/send-verification', {}),
    verify: token => request('auth/verify', { token }),
    resetRequest: email => request('auth/reset-request', { email }),
    resetConfirm: data => request('auth/reset-confirm', data),
    unsubscribe: token => request('digest/unsubscribe', { token }),
    githubLoginUrl: `${base}/auth/github/start`,
    catalogue: (filters = {}, options) => request(`catalogue?${query(filters)}`, undefined, options),
    entry: entry => request(`entries/${id(entry)}`), history: entry => request(`entries/${id(entry)}/history`),
    create: (kind, data) => request('entries', { kind, data }),
    save: (entry, revision, data) => entryAction(entry, 'save', { revision, data }),
    submit: (entry, revision) => entryAction(entry, 'submit', { revision }),
    review: (entry, revision, decision, note, checks = {}) => entryAction(entry, 'review', { revision, decision, note, ...checks }),
    withdraw: (entry, reason) => entryAction(entry, 'withdraw', { reason }),
    star: (entry, enabled, collection = '默认收藏') => entryAction(entry, 'star', { enabled, collection }),
    watch: (entry, events) => entryAction(entry, 'watch', { events }),
    release: (entry, data) => entryAction(entry, 'release', data),
    reply: (entry, body) => entryAction(entry, 'replies', { body }),
    reviewReply: (reply, approve, reason = '') => request(`replies/${id(reply)}/review`, { approve, reason }),
    accept: reply => request(`replies/${id(reply)}/accept`, {}),
    addTask: (entry, data) => entryAction(entry, 'tasks', data),
    claimTask: task => request(`tasks/${id(task)}/claim`, {}),
    submitTask: (task, evidence) => request(`tasks/${id(task)}/submit`, { evidence }),
    reviewTask: (task, approve, note) => request(`tasks/${id(task)}/review`, { approve, note }),
    upload: file => { const data = new FormData(); data.append('file', file); return request('uploads', data); },
    uploadInfo: upload => request(`uploads/${id(upload)}`),
    contributions: (filters = {}) => request(`contributions?${query(filters)}`),
    member: username => request(`members/${id(username)}`),
    notifications: () => request('notifications'), readNotifications: ids => request('notifications/read', { ids }),
    moderation: () => request('moderation'),
    report: (entry, reason) => entryAction(entry, 'report', { reason }),
    resolveReport: (report, resolution) => request(`reports/${id(report)}`, { resolution }),
    externalSearch: (q, provider = 'github') => request(`search/external?${query({q, provider})}`),
    inspectGithub: repository => request('github/inspect', { repository }),
    summarizeGithub: repository => request('github/summarize', { repository }),
    githubProject: repository => request(`github/project?${query({repository})}`),
    curateGithub: data => request('github/curate', data), selected: () => request('github/selected'),
    job: job => request(`jobs/${id(job)}`),
    feed: (filters = {}) => request(`feed?${query(filters)}`),
    feedback: (repository, action) => request('feed/feedback', { repository, action }),
    circleCapabilities: () => request('circle/capabilities'),
    circleBoards: () => request('circle/boards'),
    saveCircleBoard: data => request('circle/boards', data),
    circleFeed: (filters = {}) => request(`circle/feed?${query(filters)}`),
    circlePost: entry => request(`circle/posts/${id(entry)}`),
    createCirclePost: data => request('circle/posts', { data }),
    circlePreferences: () => request('circle/preferences'),
    saveCirclePreferences: data => request('circle/preferences', data),
    resetCircleRecommendations: () => request('circle/reset', {}),
    circleFollowing: () => request('circle/following'),
    followCreator: (username, enabled, notify = false) => request('circle/follow-creator', { username, enabled, notify }),
    followBoard: (board, enabled, notify = false) => request('circle/follow-board', { board, enabled, notify }),
    likeCirclePost: (entry, enabled) => request(`circle/posts/${id(entry)}/like`, { enabled }),
    circleFeedback: (entry, action) => request(`circle/posts/${id(entry)}/feedback`, { action }),
    selectCirclePost: (entry, revision, enabled, reason, sourceChecked = false) => request(`circle/posts/${id(entry)}/select`, { revision, enabled, reason, sourceChecked }),
    workflow: (goal, repositories) => request('feed/workflow', { goal, repositories }),
    workspace: workspace => request(`workspaces/${id(workspace)}`),
    createWorkspace: data => request('workspaces', data),
    saveWorkspace: (workspace, data) => request(`workspaces/${id(workspace)}`, data),
    bibliographyUrl: workspace => `${base}/workspaces/${id(workspace)}/bibliography`,
    plan: data => request('planning', data), backup: () => request('backup'), restore: data => request('restore', data),
    saveSource: data => request('sources', data), refreshSource: source => request(`sources/${id(source)}/refresh`, {}),
  };
}

export const hubApi = createHubClient();
