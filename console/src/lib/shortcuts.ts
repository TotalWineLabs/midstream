/**
 * Sent by `/` and by ⌘K / Ctrl+K before the command menu opens, with the key as its `detail`: `'/'`
 * or `'k'`. A page with a search box of its own focuses it and cancels the event, and the menu stays
 * shut: the search page claims both keys, a Settings page only `/`.
 */
export const FOCUS_SEARCH_EVENT = 'console:focus-search';

export type FocusSearchKey = '/' | 'k';
