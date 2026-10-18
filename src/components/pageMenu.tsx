import { CopyPlus, FileOutput, FilePlus2, Files, RotateCcw, RotateCw, Trash2 } from 'lucide-react';
import { actions, deletePages, duplicatePages, insertBlankPage, rotatePages } from '../store';
import { extractPages, insertPdfPages } from '../lib/commands';
import type { MenuItem } from './ui';

/** Actions for a set of pages, shared by the thumbnail list and the organizer. */
export function pageMenuItems(ids: string[]): MenuItem[] {
  const pages = actions.get().pages;
  const indices = ids.map((id) => pages.findIndex((p) => p.id === id)).filter((i) => i >= 0);
  const first = Math.min(...indices);
  const last = Math.max(...indices);
  const n = ids.length;
  const plural = n > 1 ? `${n} pages` : 'page';
  return [
    { label: 'Rotate clockwise', icon: <RotateCw size={15} />, onClick: () => rotatePages(ids, 90) },
    { label: 'Rotate counterclockwise', icon: <RotateCcw size={15} />, onClick: () => rotatePages(ids, -90) },
    { separator: true },
    { label: `Duplicate ${plural}`, icon: <Files size={15} />, onClick: () => duplicatePages(ids) },
    { label: 'Insert blank page before', icon: <CopyPlus size={15} />, onClick: () => insertBlankPage(first) },
    { label: 'Insert blank page after', icon: <CopyPlus size={15} />, onClick: () => insertBlankPage(last + 1) },
    { label: 'Insert pages from file…', icon: <FilePlus2 size={15} />, onClick: () => insertPdfPages(last + 1) },
    { separator: true },
    { label: `Extract ${plural}…`, icon: <FileOutput size={15} />, onClick: () => extractPages(ids) },
    { label: `Delete ${plural}`, icon: <Trash2 size={15} />, danger: true, shortcut: 'Del', onClick: () => deletePages(ids) },
  ];
}
