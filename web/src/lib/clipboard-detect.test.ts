import { describe, expect, it } from 'vitest';
import {
  companionTextForImagePaste,
  dragHasFiles,
  filesFromDataTransfer,
  splitClipboard,
} from './clipboard-detect';

function makeItem(kind: 'string' | 'file', type: string): DataTransferItem {
  return { kind, type } as unknown as DataTransferItem;
}
function makeData(items: DataTransferItem[]): DataTransfer {
  return { items: items as unknown as DataTransferItemList } as DataTransfer;
}

describe('splitClipboard', () => {
  it('detects image-only paste (single PNG file)', () => {
    const r = splitClipboard(makeData([makeItem('file', 'image/png')]));
    expect(r.imageOnly).toBe(true);
    expect(r.imageItems).toHaveLength(1);
  });

  it('detects image-only paste with multiple images', () => {
    const r = splitClipboard(
      makeData([makeItem('file', 'image/png'), makeItem('file', 'image/jpeg')]),
    );
    expect(r.imageOnly).toBe(true);
    expect(r.imageItems).toHaveLength(2);
  });

  it('treats image + text as mixed (not image-only)', () => {
    const r = splitClipboard(
      makeData([makeItem('file', 'image/png'), makeItem('string', 'text/plain')]),
    );
    expect(r.imageOnly).toBe(false);
    expect(r.imageItems).toHaveLength(1);
  });

  it('treats text-only paste as not image-only', () => {
    const r = splitClipboard(makeData([makeItem('string', 'text/plain')]));
    expect(r.imageOnly).toBe(false);
    expect(r.imageItems).toHaveLength(0);
  });

  it('treats file (non-image) + image as mixed', () => {
    const r = splitClipboard(
      makeData([makeItem('file', 'image/png'), makeItem('file', 'application/pdf')]),
    );
    expect(r.imageOnly).toBe(false);
  });
});

describe('companionTextForImagePaste', () => {
  it('drops a macOS screenshot file:// URL', () => {
    expect(companionTextForImagePaste('file:///var/folders/xx/T/Screen%20Shot.png')).toBe('');
  });

  it('keeps real caption text', () => {
    expect(companionTextForImagePaste('see attached screenshot')).toBe('see attached screenshot');
  });
});

describe('filesFromDataTransfer / dragHasFiles', () => {
  const photo = new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' });
  const fileItem = (f: File) =>
    ({ kind: 'file', type: f.type, getAsFile: () => f }) as unknown as DataTransferItem;
  const dt = (items: DataTransferItem[], files: File[], types: string[] = []) =>
    ({ items, files, types }) as unknown as DataTransfer;

  it('reads a file delivered only as an item (iOS)', () => {
    expect(filesFromDataTransfer(dt([fileItem(photo)], []))).toEqual([photo]);
  });
  it('reads a file delivered only in files', () => {
    expect(filesFromDataTransfer(dt([], [photo]))).toEqual([photo]);
  });
  it('does not double-count a file present in both', () => {
    expect(filesFromDataTransfer(dt([fileItem(photo)], [photo]))).toEqual([photo]);
  });
  it('skips string items and null getAsFile', () => {
    const s = { kind: 'string', type: 'text/plain' } as unknown as DataTransferItem;
    const dead = {
      kind: 'file',
      type: 'image/png',
      getAsFile: () => null,
    } as unknown as DataTransferItem;
    expect(filesFromDataTransfer(dt([s, dead], []))).toEqual([]);
    expect(filesFromDataTransfer(null)).toEqual([]);
  });
  it('sees files during dragover by type OR item kind', () => {
    expect(dragHasFiles(dt([], [], ['Files']))).toBe(true);
    expect(dragHasFiles(dt([{ kind: 'file', type: 'image/jpeg' } as DataTransferItem], []))).toBe(
      true,
    );
    expect(
      dragHasFiles(
        dt([{ kind: 'string', type: 'text/plain' } as DataTransferItem], [], ['text/plain']),
      ),
    ).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
  });
});
