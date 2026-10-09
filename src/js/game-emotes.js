// Copied with owner's permission from E:/Lv/game/js/engine/sprites.js (2026-10-09).
// Original vector symbols only; no story or private game material.
  const OUT = 'stroke="#fff" stroke-width="10" paint-order="stroke" stroke-linejoin="round"';
  export const gameEmotes = {
    '!': `<svg viewBox="0 0 110 110"><path d="M44,10 h24 l-4,62 h-16 z" fill="#f06a8c" ${OUT}/><circle cx="56" cy="92" r="11" fill="#f06a8c" ${OUT}/></svg>`,
    '?': `<svg viewBox="0 0 110 110"><path d="M34,38 C34,18 48,8 60,8 C78,8 88,20 88,36 C88,54 66,58 64,74 L64,78 L50,78 L50,72 C50,52 72,48 72,36 C72,26 66,22 60,22 C52,22 48,28 48,38 Z" fill="#7fa2dc" ${OUT}/><circle cx="57" cy="95" r="10" fill="#7fa2dc" ${OUT}/></svg>`,
    '...': `<svg viewBox="0 0 110 110"><path d="M12,30 h86 a10,10 0 0 1 10,10 v36 a10,10 0 0 1 -10,10 h-50 l-18,16 v-16 h-18 a10,10 0 0 1 -10,-10 v-36 a10,10 0 0 1 10,-10 z" fill="#fff" stroke="#9a93ad" stroke-width="5"/><circle cx="34" cy="58" r="7" fill="#6d6280"/><circle cx="56" cy="58" r="7" fill="#6d6280"/><circle cx="78" cy="58" r="7" fill="#6d6280"/></svg>`,
    '♪': `<svg viewBox="0 0 110 110"><path d="M42,20 L90,10 L90,70 A14,12 0 1 1 78,58 L78,32 L54,37 L54,82 A14,12 0 1 1 42,70 Z" fill="#f18b5f" ${OUT}/></svg>`,
    anger: `<svg viewBox="0 0 110 110"><g fill="none" stroke="#e8455f" stroke-width="10" stroke-linecap="round"><path d="M20,44 C34,44 44,34 44,20"/><path d="M66,20 C66,34 76,44 90,44"/><path d="M20,66 C34,66 44,76 44,90"/><path d="M66,90 C66,76 76,66 90,66"/></g></svg>`,
    sweat: `<svg viewBox="0 0 110 110"><path d="M60,12 C74,36 88,52 88,68 A28,28 0 0 1 32,68 C32,52 46,36 60,12 Z" fill="#8fc3ea" ${OUT}/><ellipse cx="50" cy="66" rx="6" ry="10" fill="#fff" opacity=".7"/></svg>`,
    heart: `<svg viewBox="0 0 110 110"><path d="M55,96 C20,70 8,52 8,34 C8,18 20,8 34,8 C44,8 52,14 55,22 C58,14 66,8 76,8 C90,8 102,18 102,34 C102,52 90,70 55,96 Z" fill="#f06a8c" ${OUT}/></svg>`,
    shock: `<svg viewBox="0 0 110 110"><g stroke="#6d6280" stroke-width="8" stroke-linecap="round"><line x1="28" y1="18" x2="36" y2="60"/><line x1="55" y1="10" x2="55" y2="58"/><line x1="82" y1="18" x2="74" y2="60"/></g></svg>`,
    blush: `<svg viewBox="0 0 110 110"><g stroke="#f06a8c" stroke-width="6" stroke-linecap="round"><line x1="20" y1="70" x2="32" y2="52"/><line x1="36" y1="72" x2="48" y2="54"/><line x1="62" y1="72" x2="74" y2="54"/><line x1="78" y1="70" x2="90" y2="52"/></g></svg>`,
    zzz: `<svg viewBox="0 0 110 110"><text x="18" y="84" font-size="56" font-weight="700" fill="#9a93ad" ${OUT} font-family="Arial">z</text><text x="56" y="52" font-size="40" font-weight="700" fill="#9a93ad" ${OUT} font-family="Arial">z</text></svg>`,
  };
