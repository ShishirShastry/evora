import { useState } from 'react';
import {
  addExportSetting,
  allExportTargets,
  EXPORT_FORMATS,
  exportTargetsOf,
  formatConstraint,
  newExportSetting,
  parseConstraint,
  removeExportSetting,
  safeFileName,
  updateExportSetting,
  type ExportFormat,
  type ExportSetting,
  type ExportTarget,
  type NodeId,
} from '../../core';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { useEditor, useEditorContext } from '../editor/EditorContext';
import { exportEnvironment, runExport } from '../editor/exporting';
import { Row, Section } from './panelParts';
import { CommitInput } from './TokenSections';

/**
 * Export: the ways the selected layers (or the page) are exported, kept on
 * them, and the button that makes the files. The files are made by the
 * export engine from the document as it is.
 */

function useExporter(): { busy: boolean; result: { count: number; warnings: string[] } | null; run: (targets: readonly ExportTarget[], archive: string) => void } {
  const { store, storage, images } = useEditorContext();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ count: number; warnings: string[] } | null>(null);
  return {
    busy,
    result,
    run(targets, archive) {
      if (busy || targets.length === 0) return;
      setBusy(true);
      setResult(null);
      runExport(store.getState().doc, targets, exportEnvironment(storage, images), safeFileName(archive))
        .then((out) => setResult({ count: out.files.length, warnings: out.warnings }))
        .catch((error: unknown) => setResult({ count: 0, warnings: [error instanceof Error ? error.message : 'The export failed.'] }))
        .finally(() => setBusy(false));
    },
  };
}

function Result({ result }: { result: { count: number; warnings: string[] } | null }) {
  if (!result) return null;
  return (
    <div role="status" aria-label="Export result" className="flex flex-col gap-1 text-dim">
      <span>{result.count === 0 ? 'Nothing was exported.' : result.count === 1 ? 'Exported 1 file.' : `Exported ${result.count} files in one ZIP archive.`}</span>
      {result.warnings.length > 0 && (
        <ul className="m-0 pl-4">
          {result.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SettingRow({ ids, setting, index }: { ids: readonly NodeId[]; setting: ExportSetting; index: number }) {
  const { store } = useEditorContext();
  const [more, setMore] = useState(false);
  const label = `Export ${index + 1}`;
  const change = (patch: Partial<ExportSetting>): void => store.getState().apply('Change export', (d) => updateExportSetting(d, ids, index, patch));
  return (
    <li className="flex flex-col gap-1.5" aria-label={label}>
      <Row>
        <CommitInput
          label={`${label} size`}
          value={formatConstraint(setting.constraint)}
          className="w-14 flex-none"
          onCommit={(text) => {
            const constraint = parseConstraint(text);
            // A scale is written into the suffix the way assets are usually named, when the suffix was the old scale's.
            if (constraint) change({ constraint, suffix: setting.suffix === '' || /^@\d+(\.\d+)?x$/.test(setting.suffix) ? (constraint.type === 'SCALE' && constraint.value !== 1 ? `@${constraint.value}x` : '') : setting.suffix });
          }}
        />
        <CommitInput label={`${label} suffix`} value={setting.suffix} placeholder="Suffix" onCommit={(suffix) => change({ suffix })} />
        <select aria-label={`${label} format`} className="od-field w-16 flex-none" value={setting.format} onChange={(event) => change({ format: event.currentTarget.value as ExportFormat })}>
          {EXPORT_FORMATS.map((format) => (
            <option key={format} value={format}>
              {format}
            </option>
          ))}
        </select>
        <button type="button" className="od-icon-button flex-none" aria-label={`${label} options`} aria-expanded={more} title="Options" onClick={() => setMore(!more)}>
          <Icon name="chevronDown" size={10} />
        </button>
        <button type="button" className="od-icon-button flex-none" aria-label={`Remove ${label.toLowerCase()}`} title="Remove" onClick={() => store.getState().apply('Remove export', (d) => removeExportSetting(d, ids, index))}>
          <Icon name="close" />
        </button>
      </Row>
      {more && (
        <div className="flex flex-col gap-1.5 rounded border border-line p-1.5">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" aria-label={`${label} page background`} checked={setting.background} onChange={(event) => change({ background: event.currentTarget.checked })} />
            {setting.format === 'JPG' ? 'On the page’s colour (white otherwise)' : 'On the page’s colour (transparent otherwise)'}
          </label>
          {setting.format === 'JPG' && (
            <Row>
              <span className="w-16 flex-none text-dim">Quality</span>
              <select aria-label={`${label} quality`} className="od-field min-w-0 flex-1" value={String(setting.quality)} onChange={(event) => change({ quality: Number(event.currentTarget.value) })}>
                {[1, 0.9, 0.8, 0.6, 0.4].map((quality) => (
                  <option key={quality} value={String(quality)}>
                    {Math.round(quality * 100)}%
                  </option>
                ))}
                {![1, 0.9, 0.8, 0.6, 0.4].includes(setting.quality) && <option value={String(setting.quality)}>{Math.round(setting.quality * 100)}%</option>}
              </select>
            </Row>
          )}
          {setting.format === 'SVG' && (
            <label className="flex items-center gap-1.5">
              <input type="checkbox" aria-label={`${label} id attributes`} checked={setting.svgIds} onChange={(event) => change({ svgIds: event.currentTarget.checked })} />
              Name each layer’s element (id)
            </label>
          )}
          {setting.format === 'PDF' && (
            <>
              <Row>
                <span className="w-16 flex-none text-dim">Content</span>
                <select aria-label={`${label} PDF content`} className="od-field min-w-0 flex-1" value={setting.pdfContent} onChange={(event) => change({ pdfContent: event.currentTarget.value as ExportSetting['pdfContent'] })}>
                  <option value="VECTOR">Vectors</option>
                  <option value="PICTURE">As a picture (keeps shadows and blurs)</option>
                </select>
              </Row>
              {setting.pdfContent === 'VECTOR' && (
                <Row>
                  <span className="w-16 flex-none text-dim">Text</span>
                  <select aria-label={`${label} PDF text`} className="od-field min-w-0 flex-1" value={setting.pdfText} onChange={(event) => change({ pdfText: event.currentTarget.value as ExportSetting['pdfText'] })}>
                    <option value="TEXT">As text, in a standard font (selectable)</option>
                    <option value="PICTURE">As pictures (exact look)</option>
                  </select>
                </Row>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** The export settings of some layers, or of a page, and the button that exports them. */
export function ExportSection({ ids, name }: { ids: readonly NodeId[]; name: string }) {
  const { store } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const exporter = useExporter();
  const first = doc.nodes[ids[0] as NodeId];
  if (!first) return null;
  const settings = first.exportSettings;
  // Several layers show their settings only when they have the same ones.
  const same = ids.every((id) => JSON.stringify(doc.nodes[id]?.exportSettings) === JSON.stringify(settings));
  const targets = exportTargetsOf(doc, ids);
  return (
    <Section
      title="Export"
      action={
        <button type="button" className="od-icon-button" aria-label="Add export setting" title="Add a way to export" onClick={() => store.getState().apply('Add export', (d) => addExportSetting(d, ids, newExportSetting()))}>
          <Icon name="plus" size={13} />
        </button>
      }
    >
      {!same && <p className="m-0 text-faint">The selected layers are exported in different ways. Each keeps its own.</p>}
      {same && settings.length === 0 && <p className="m-0 text-faint">Add a way to export: a size, a format and a suffix for the file’s name.</p>}
      {same && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {settings.map((setting, index) => (
            <SettingRow key={index} ids={ids} setting={setting} index={index} />
          ))}
        </ul>
      )}
      {targets.length > 0 && (
        <button type="button" className="od-button !h-[28px]" disabled={exporter.busy} onClick={() => exporter.run(targets, name)}>
          {exporter.busy ? 'Exporting…' : `Export ${name}`}
        </button>
      )}
      <Result result={exporter.result} />
    </Section>
  );
}

/** The export settings of the page that is shown, for when nothing is selected. */
export function PageExportSection() {
  const pageId = useEditor((s) => s.pageId);
  const name = useEditor((s) => s.doc.nodes[s.pageId]?.name ?? 'page');
  return <ExportSection ids={[pageId]} name={name} />;
}

/** Everything in the file that has export settings, to export together. */
export function ExportDialog({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const exporter = useExporter();
  const targets = allExportTargets(doc);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const chosen = targets.filter((target) => !skipped.has(target.fileName));
  return (
    <Dialog
      title="Export"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className="od-button" onClick={onClose}>
            Close
          </button>
          <button type="button" className="od-button" data-autofocus disabled={exporter.busy || chosen.length === 0} onClick={() => exporter.run(chosen, doc.name)}>
            {exporter.busy ? 'Exporting…' : `Export ${chosen.length} ${chosen.length === 1 ? 'file' : 'files'}`}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {targets.length === 0 && <p className="m-0 text-dim">Nothing in this file has export settings yet. Select a layer, or nothing for the page, and add one under “Export” in the Design tab.</p>}
        <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Files to export">
          {targets.map((target) => (
            <li key={target.fileName}>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!skipped.has(target.fileName)}
                  onChange={(event) => {
                    const next = new Set(skipped);
                    if (event.currentTarget.checked) next.delete(target.fileName);
                    else next.add(target.fileName);
                    setSkipped(next);
                  }}
                />
                <span className="min-w-0 flex-1 truncate">{target.fileName}</span>
                <span className="flex-none text-dim">
                  {doc.nodes[target.nodeId]?.type === 'PAGE' ? 'Page' : 'Layer'}, {formatConstraint(target.setting.constraint)}
                </span>
              </label>
            </li>
          ))}
        </ul>
        {targets.length > 1 && <p className="m-0 text-faint">More than one file is saved as one ZIP archive.</p>}
        <Result result={exporter.result} />
      </div>
    </Dialog>
  );
}
