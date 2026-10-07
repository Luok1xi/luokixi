// Settings-style functional symbols: shared geometry, weight and one tint.
// Lucide source and full license are preserved in ./vendor/.
import { glyphs } from './vendor/lucide-glyphs.js';
import '../styles/app-icons.css';

const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function appIcon(name, label = '') {
  const key = Object.hasOwn(glyphs, name) ? name : 'study';
  return `<span class="ap-symbol app-icon app-icon--${key}"${label ? ` role="img" aria-label="${escape(label)}"` : ' aria-hidden="true"'}><svg class="app-icon__glyph" viewBox="0 0 24 24" focusable="false" aria-hidden="true">${glyphs[key]}</svg></span>`;
}
