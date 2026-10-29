import type { TranscriptItem } from "../transcript.ts";

// mergeItems puts a page of items into what a chat holds: a page the desk
// read afresh (reset) replaces it, and otherwise items with the same id are
// replaced (an open tool group is sent again) and the rest appended.
export function mergeItems(held: TranscriptItem[], page: { items: TranscriptItem[] | null; reset?: boolean }): TranscriptItem[] {
  const items = page.items ?? [];
  if (page.reset) return items;
  const list = [...held];
  const at = new Map(list.map((it, i) => [it.id, i]));
  for (const it of items) {
    const i = at.get(it.id);
    if (i === undefined) {
      at.set(it.id, list.length);
      list.push(it);
    } else list[i] = it;
  }
  return list;
}
