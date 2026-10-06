// 听力迷你播放器。页面上同时只播一段。
// 用法：mountPlayer(container, url, label)
const ICON_PLAY = '<svg viewBox="0 0 14 14"><path d="M3 1.8v10.4a.6.6 0 0 0 .9.5l8.4-5.2a.6.6 0 0 0 0-1L3.9 1.3a.6.6 0 0 0-.9.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 14 14"><rect x="2.5" y="1.5" width="3.2" height="11" rx=".8"/><rect x="8.3" y="1.5" width="3.2" height="11" rx=".8"/></svg>';

let playing = null;
const fmt = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '--:--');

export function mountPlayer(el, url, label) {
  el.classList.add('player');
  el.innerHTML = `
    <button class="player-btn" type="button" aria-label="播放${label}">${ICON_PLAY}</button>
    <div class="player-track" role="slider" tabindex="0" aria-label="${label} 进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="player-fill"></div></div>
    <span class="player-time">0:00</span>`;
  const [btn, track, time] = [el.querySelector('.player-btn'), el.querySelector('.player-track'), el.querySelector('.player-time')];
  const audio = new Audio();
  audio.preload = 'none';
  audio.src = url;

  const sync = () => {
    const r = audio.duration ? audio.currentTime / audio.duration : 0;
    track.style.setProperty('--r', r.toFixed(4));
    track.setAttribute('aria-valuenow', String(Math.round(r * 100)));
    time.textContent = audio.paused && !audio.currentTime ? fmt(audio.duration) : fmt(audio.currentTime);
  };
  const setIcon = () => {
    btn.innerHTML = audio.paused ? ICON_PLAY : ICON_PAUSE;
    btn.setAttribute('aria-label', `${audio.paused ? '播放' : '暂停'}${label}`);
  };

  btn.addEventListener('click', () => {
    if (audio.paused) {
      if (playing && playing !== audio) playing.pause();
      playing = audio;
      audio.play().catch(() => (time.textContent = '无法播放'));
    } else audio.pause();
  });
  const seek = (ratio) => audio.duration && (audio.currentTime = Math.max(0, Math.min(1, ratio)) * audio.duration);
  track.addEventListener('click', (e) => {
    const r = track.getBoundingClientRect();
    seek((e.clientX - r.left) / r.width);
  });
  track.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') audio.currentTime += 5;
    if (e.key === 'ArrowLeft') audio.currentTime -= 5;
  });
  ['play', 'pause', 'ended'].forEach((ev) => audio.addEventListener(ev, setIcon));
  ['timeupdate', 'loadedmetadata', 'seeked'].forEach((ev) => audio.addEventListener(ev, sync));
}
