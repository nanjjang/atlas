/**
 * The tree's icons.
 *
 * A column of names is a column of one shape, and reading it means reading
 * every word. An icon is the part a reader takes in without reading: which rows
 * are folders, which are open, and what kind of file each of the rest is.
 *
 * They are an inline sprite rather than a font or a set of images because the
 * webview's content policy allows neither a remote stylesheet nor a fetched
 * asset, and because `currentColor` lets one drawing serve every theme and take
 * the language colour the tree already has for it.
 *
 * Drawn on a 16-unit grid, stroked rather than filled, so they hold up at the
 * size a 22px sidebar row leaves them and at whatever the editor's font size
 * scales the panel's to.
 */

interface Icon {
  id: string;
  /** Path data, drawn with the shared stroke. */
  path: string;
  /** Anything that has to be filled instead, such as a cursor block. */
  solid?: string;
}

const ICONS: Icon[] = [
  { id: 'chevron-right', path: 'M6.5 4 10.5 8 6.5 12' },
  { id: 'chevron-down', path: 'M4 6.5 8 10.5 12 6.5' },
  {
    id: 'folder',
    path: 'M2 12.75V3.6c0-.33.27-.6.6-.6h3.3c.2 0 .38.1.49.27L7.5 5H13.4c.33 0 .6.27.6.6v6.55c0 .33-.27.6-.6.6H2.6a.6.6 0 0 1-.6-.6Z',
  },
  {
    // The flap lifted and the body sheared: open reads at a glance, which is
    // the whole reason a folder icon is worth a column at all.
    id: 'folder-open',
    path: 'M2 12.4V3.6c0-.33.27-.6.6-.6h3.3c.2 0 .38.1.49.27L7.5 5h4.9c.33 0 .6.27.6.6V7M2.4 13h10.04a.6.6 0 0 0 .57-.41l1.4-4.2A.4.4 0 0 0 14 7.8H4.63a.6.6 0 0 0-.57.41l-1.6 4.79Z',
  },
  { id: 'file', path: 'M9 1.5H4.6a.6.6 0 0 0-.6.6v11.8c0 .33.27.6.6.6h6.8a.6.6 0 0 0 .6-.6V4.5L9 1.5ZM9 1.5v3h3' },
  /*
   * The rest carry no enclosing page. A file outline with a mark inside it is
   * two shapes in the space of one, and at the fifteen-odd pixels a row gives
   * them the two close up into a filled block — which is how every one of them
   * ends up looking like every other. The mark alone stays legible, and the
   * column it sits in already says these are files.
   */
  { id: 'code', path: 'M5.8 4.2 1.8 8l4 3.8M10.2 4.2 14.2 8l-4 3.8' },
  { id: 'braces', path: 'M6.5 2C5 2 5 4 5 5.2 5 6.6 4.4 8 3 8c1.4 0 2 1.4 2 2.8 0 1.2 0 3.2 1.5 3.2M9.5 2c1.5 0 1.5 2 1.5 3.2C11 6.6 11.6 8 13 8c-1.4 0-2 1.4-2 2.8 0 1.2 0 3.2-1.5 3.2' },
  { id: 'doc', path: 'M9 1.5H4.6a.6.6 0 0 0-.6.6v11.8c0 .33.27.6.6.6h6.8a.6.6 0 0 0 .6-.6V4.5L9 1.5ZM9 1.5v3h3M6 8.5h4M6 11.2h2.5' },
  // A schema: the cylinder every database diagram has used for fifty years.
  { id: 'database', path: 'M8 2c3.3 0 5 .9 5 2s-1.7 2-5 2-5-.9-5-2 1.7-2 5-2ZM3 4v8c0 1.1 1.7 2 5 2s5-.9 5-2V4M3 8c0 1.1 1.7 2 5 2s5-.9 5-2' },
  { id: 'style', path: 'M8 1.8c2.4 2.9 4.4 5.2 4.4 7.3A4.4 4.4 0 0 1 8 13.5a4.4 4.4 0 0 1-4.4-4.4C3.6 7 5.6 4.7 8 1.8Z' },
  { id: 'image', path: 'M2.4 12.6V3.4c0-.33.27-.6.6-.6h10c.33 0 .6.27.6.6v9.2a.6.6 0 0 1-.6.6H3a.6.6 0 0 1-.6-.6ZM2.6 12l3.6-4a.6.6 0 0 1 .9 0l3.5 4M10.4 6.2h.01' },
  { id: 'terminal', path: 'M2.6 3.6 6.8 8l-4.2 4.4M8 12.4h5.4' },
];

/**
 * What each of the tree's language buckets is drawn as. Several share a shape
 * on purpose: the question the icon answers is "what kind of thing is this",
 * and Go beside Rust is one answer.
 */
export const ICON_BY_LANGUAGE: Record<string, string> = {
  ts: 'code', js: 'code', py: 'code', jvm: 'code', go: 'code', rust: 'code',
  ruby: 'code', php: 'code', dotnet: 'code', native: 'code', markup: 'code',
  dart: 'code',
  schema: 'database',
  config: 'braces',
  docs: 'doc',
  style: 'style',
  asset: 'image',
  shell: 'terminal',
  other: 'file',
};

/**
 * The sprite, to be dropped once into a webview's body. `<use>` then costs a
 * single element per row rather than a drawing per row, which on a tree of
 * several thousand entries is the difference that matters.
 */
export function iconSprite(): string {
  // The stroke goes on each symbol rather than once on the sprite around them.
  // A `<use>` clones the symbol into a shadow tree under the referencing `<svg>`
  // and inherits from *there*, so anything set on the sprite's own root never
  // reaches the instance — which leaves every icon drawn with the initial
  // `fill: black` and no stroke at all, as a row of small solid blobs.
  const stroke = 'fill="none" stroke="currentColor" stroke-width="1.25" '
    + 'stroke-linecap="round" stroke-linejoin="round"';
  const symbols = ICONS.map((icon) => {
    const solid = icon.solid ? `<path d="${icon.solid}" fill="currentColor" stroke="none"/>` : '';
    return `<symbol id="repogram-${icon.id}" viewBox="0 0 16 16" ${stroke}>`
      + `<path d="${icon.path}"/>${solid}</symbol>`;
  }).join('');
  return `<svg class="repogram-sprite" aria-hidden="true" focusable="false">${symbols}</svg>`;
}
