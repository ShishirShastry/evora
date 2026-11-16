import { patchNodes } from '../document/mutate';
import { isLayer, isPage, type DesignNode, type Document, type ExportFormat, type ExportSetting, type NodeId } from '../document/schema';
import { getLibraryPages, getPageIdOf } from '../scene/tree';

/**
 * Export settings: how a layer or a page is exported, kept on it so that it
 * can be exported the same way again, alone or with everything else that
 * has settings. Making the files is the engine's work (`engine/export`).
 */

export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = { PNG: 'png', JPG: 'jpg', SVG: 'svg', PDF: 'pdf' };
export const EXPORT_MIME_TYPES: Record<ExportFormat, string> = { PNG: 'image/png', JPG: 'image/jpeg', SVG: 'image/svg+xml', PDF: 'application/pdf' };

export function newExportSetting(patch: Partial<ExportSetting> = {}): ExportSetting {
  return { format: 'PNG', constraint: { type: 'SCALE', value: 1 }, suffix: '', background: false, quality: 0.9, svgIds: false, pdfContent: 'VECTOR', pdfText: 'TEXT', ...patch };
}

/** A size as it is typed and shown: "2x" for a scale, "512w" for a width, "300h" for a height. */
export function formatConstraint(constraint: ExportSetting['constraint']): string {
  const value = Math.round(constraint.value * 100) / 100;
  return constraint.type === 'SCALE' ? `${value}x` : constraint.type === 'WIDTH' ? `${value}w` : `${value}h`;
}

/** Reads a size as it is typed. A bare number is a scale. Null when it is not a size. */
export function parseConstraint(text: string): ExportSetting['constraint'] | null {
  const match = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(x|w|h|px)?\s*$/i.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = (match[2] ?? 'x').toLowerCase();
  if (!Number.isFinite(value) || value <= 0) return null;
  if (unit === 'x') return value >= 0.01 && value <= 64 ? { type: 'SCALE', value } : null;
  const pixels = Math.round(value);
  if (pixels < 1 || pixels > 32768) return null;
  return { type: unit === 'h' ? 'HEIGHT' : 'WIDTH', value: pixels };
}

/** How much bigger than the design the export is, for something of a size. */
export function exportScale(constraint: ExportSetting['constraint'], width: number, height: number): number {
  if (constraint.type === 'SCALE') return constraint.value;
  const side = constraint.type === 'WIDTH' ? width : height;
  return side > 0 ? constraint.value / side : 1;
}

/** A name that every file system takes: nothing a path or a shell reads as its own. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  return cleaned || 'Untitled';
}

/** The file name of an export: the layer's name, the setting's suffix, the format's extension. */
export function exportFileName(name: string, setting: Pick<ExportSetting, 'suffix' | 'format'>): string {
  return `${safeFileName(`${name}${setting.suffix}`)}.${EXPORT_EXTENSIONS[setting.format]}`;
}

/** Makes names differ where two are the same, without regard to case: "Icon.png", "Icon 2.png". */
export function uniqueFileNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} ${n}${extension}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

function settingsOf(node: DesignNode | undefined): ExportSetting[] | null {
  return node && (isLayer(node) || isPage(node)) ? node.exportSettings : null;
}

/** Adds a way of exporting to layers or a page. Each gets its own, with "@2x" and the like as the suffix when the scale is not 1. */
export function addExportSetting(doc: Document, ids: readonly NodeId[], setting: ExportSetting = newExportSetting()): Document {
  const patches: Record<NodeId, { exportSettings: ExportSetting[] }> = {};
  for (const id of ids) {
    const settings = settingsOf(doc.nodes[id]);
    if (settings) patches[id] = { exportSettings: [...settings, { ...setting, constraint: { ...setting.constraint } }] };
  }
  return patchNodes(doc, patches);
}

export function updateExportSetting(doc: Document, ids: readonly NodeId[], index: number, change: Partial<ExportSetting>): Document {
  const patches: Record<NodeId, { exportSettings: ExportSetting[] }> = {};
  for (const id of ids) {
    const settings = settingsOf(doc.nodes[id]);
    if (settings && settings[index]) patches[id] = { exportSettings: settings.map((setting, at) => (at === index ? { ...setting, ...change } : setting)) };
  }
  return patchNodes(doc, patches);
}

export function removeExportSetting(doc: Document, ids: readonly NodeId[], index: number): Document {
  const patches: Record<NodeId, { exportSettings: ExportSetting[] }> = {};
  for (const id of ids) {
    const settings = settingsOf(doc.nodes[id]);
    if (settings && settings[index]) patches[id] = { exportSettings: settings.filter((_, at) => at !== index) };
  }
  return patchNodes(doc, patches);
}

/** Something to export: a layer or a page, one of the ways it is exported, and the name of the file that makes. */
export interface ExportTarget {
  nodeId: NodeId;
  setting: ExportSetting;
  fileName: string;
}

/** The exports of some layers or pages, one for each of their settings, with file names that differ. */
export function exportTargetsOf(doc: Document, ids: readonly NodeId[]): ExportTarget[] {
  const out: ExportTarget[] = [];
  for (const id of ids) {
    const node = doc.nodes[id];
    const settings = settingsOf(node);
    if (!node || !settings) continue;
    for (const setting of settings) out.push({ nodeId: id, setting, fileName: exportFileName(node.name, setting) });
  }
  const names = uniqueFileNames(out.map((target) => target.fileName));
  return out.map((target, index) => ({ ...target, fileName: names[index] as string }));
}

/** Everything in the document that has export settings: pages first, then layers page by page. What came from a library is not the document's to export. */
export function allExportTargets(doc: Document): ExportTarget[] {
  const library = new Set(getLibraryPages(doc).map((page) => page.id));
  const ids: NodeId[] = [];
  for (const id in doc.nodes) {
    const node = doc.nodes[id] as DesignNode;
    if (!settingsOf(node)?.length) continue;
    const pageId = isPage(node) ? id : getPageIdOf(doc, id);
    if (pageId === null || library.has(pageId)) continue;
    ids.push(id);
  }
  ids.sort((a, b) => {
    const na = doc.nodes[a] as DesignNode;
    const nb = doc.nodes[b] as DesignNode;
    if (isPage(na) !== isPage(nb)) return isPage(na) ? -1 : 1;
    return na.name.localeCompare(nb.name) || (a < b ? -1 : 1);
  });
  return exportTargetsOf(doc, ids);
}
