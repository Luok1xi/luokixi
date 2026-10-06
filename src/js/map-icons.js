// Original SVG symbols, aligned to a 24px grid. Geography comes only from OSM.
const paths = {
 library: '<path d="M3 5c4-2 7-1 9 1 2-2 5-3 9-1v15c-4-2-7-1-9 0-2-1-5-2-9 0zM12 6v14"/>',
 teaching: '<path d="m2 8 10-5 10 5-10 5zM6 11v6c4 3 8 3 12 0v-6M22 8v9"/>',
 canteen: '<path d="M5 3v7m3-7v7M5 7h3M6.5 10v11M18 3c-4 3-4 8 0 9v9M18 3v9"/>',
 sports: '<circle cx="12" cy="12" r="9"/><path d="m12 7 5 4-2 6H9l-2-6zM12 3v4M21 9l-4 2M18 19l-3-2M6 19l3-2M3 9l4 2"/>',
 dorm: '<path d="M5 21V3h14v18M3 21h18M9 7h1m4 0h1M9 11h1m4 0h1M10 21v-6h4v6"/>',
 lab: '<path d="M9 3h6M10 3v7l-6 9a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2l-6-9V3M7 15h10"/>',
 hall: '<path d="m3 9 9-6 9 6M4 9h16M6 9v10m6-10v10m6-10v10M3 21h18"/>',
 clinic: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/>',
 shop: '<path d="M3 9 5 3h14l2 6M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M5 12v9h14v-9M10 21v-6h4v6"/>',
};
export function mapIcon(use) {
 return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths[use] || paths.teaching}</svg>`;
}
