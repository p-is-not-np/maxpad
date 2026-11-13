export interface ClipboardSplit {
  /** True if every item is an image file (no text/HTML/non-image siblings). */
  imageOnly: boolean;
  /** Image MIME items that should be uploaded. */
  imageItems: DataTransferItem[];
}

/**
 * Text bundled with an image paste on macOS is often a transient file:// URL
 * to the screenshot on disk. Drop it so the muxpad attachment path is what
 * the TUI sees (Claude/Cursor both echo that path into the prompt).
 */
export function companionTextForImagePaste(text: string): string {
  const t = text.trim();
  if (!t) return '';
  if (!t.startsWith('file://')) return text;
  try {
    const { pathname } = new URL(t);
    if (/\.(png|jpe?g|gif|webp|tiff?|heic|avif)$/i.test(pathname)) return '';
  } catch {
    // not a parseable file URL — keep as-is
  }
  return text;
}

export function splitClipboard(data: DataTransfer): ClipboardSplit {
  const items = Array.from(data.items);
  const imageItems = items.filter((i) => i.kind === 'file' && i.type.startsWith('image/'));
  const hasNonImage = items.some((i) => !(i.kind === 'file' && i.type.startsWith('image/')));
  return {
    imageOnly: imageItems.length > 0 && !hasNonImage,
    imageItems,
  };
}

/**
 * Does this drag carry files? Asked on `dragenter`/`dragover`, where the
 * browser is in protected mode: `getAsFile()` returns null and `files` is
 * empty, but `types` and each item's `kind` are readable. iOS Safari lists a
 * photo dragged out of Photos as an item of kind `file` and does not always
 * put `Files` in `types`, so both are checked.
 */
export function dragHasFiles(data: DataTransfer | null): boolean {
  if (!data) return false;
  if (Array.from(data.types ?? []).includes('Files')) return true;
  return Array.from(data.items ?? []).some((i) => i.kind === 'file');
}

/**
 * Every file a drop or paste carries, read from BOTH places a browser may put
 * it. Desktop browsers fill `files`; iOS Safari frequently delivers a dropped
 * or pasted photo ONLY as a `DataTransferItem` (kind `file`) with an empty
 * `files` list — so reading `files` alone was a drop that did nothing. Items
 * first, then any `files` entry not already seen (the two usually hold the
 * same objects when both are filled).
 */
export function filesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  for (const f of Array.from(data.files ?? [])) {
    if (!out.some((o) => o === f || (o.name === f.name && o.size === f.size && o.type === f.type)))
      out.push(f);
  }
  return out;
}
