import { useMemo, useState } from 'react';
import {
  addAnnotation,
  addDevResource,
  annotationsOn,
  codeConnectFor,
  composeFor,
  cssColor,
  cssFor,
  DEV_STATUSES,
  devStatusList,
  exportTargetsOf,
  inspectLayer,
  isFrame,
  isLayer,
  newExportSetting,
  removeAnnotation,
  removeDevResource,
  safeUrl,
  setCodeConnect,
  setDevStatus,
  swiftFor,
  updateAnnotation,
  type DevStatus,
  type ExportTarget,
  type LayerNode,
  type NodeId,
} from '../../core';
import { Icon } from '../components/Icon';
import { useEditor, useEditorContext } from '../editor/EditorContext';
import { exportEnvironment, runExport } from '../editor/exporting';
import { Row, Section } from './panelParts';
import { CommitInput } from './TokenSections';

/**
 * The Inspect tab: Developer Mode. What it says about the selected layer is
 * read from the layer (`inspectLayer`), the code is written from it
 * (`cssFor`, `swiftFor`, `composeFor`), and the notes, links, status and
 * code mapping it edits are kept on the layer in the document.
 */

const STATUS_LABELS: Record<DevStatus, string> = { NONE: 'Not marked', READY: 'Ready for development', COMPLETED: 'Completed' };
type Language = 'CSS' | 'SWIFT' | 'COMPOSE';
const LANGUAGE_LABELS: Record<Language, string> = { CSS: 'CSS', SWIFT: 'iOS (SwiftUI)', COMPOSE: 'Android (Compose)' };

function copyText(text: string, done: () => void): void {
  if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).then(done, () => undefined);
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <pre aria-label={label} tabIndex={0} className="m-0 max-h-64 overflow-auto whitespace-pre rounded border border-line bg-field p-2 font-mono text-[11px] leading-[1.5]">
        {code}
      </pre>
      <button
        type="button"
        className="od-button !h-[24px] self-start !px-2"
        onClick={() =>
          copyText(code, () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function LayerInspect({ layer }: { layer: LayerNode }) {
  const { store, storage, images } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const [language, setLanguage] = useState<Language>('CSS');
  const [note, setNote] = useState('');
  const [link, setLink] = useState({ name: '', url: '' });
  const [exported, setExported] = useState('');
  const sections = useMemo(() => inspectLayer(doc, layer.id), [doc, layer.id]);
  const code = language === 'CSS' ? cssFor(doc, layer.id) : language === 'SWIFT' ? swiftFor(doc, layer.id) : composeFor(doc, layer.id);
  const mapped = codeConnectFor(doc, layer.id);
  const isComponent = isFrame(layer) && (layer.kind === 'COMPONENT' || layer.kind === 'COMPONENT_SET');
  const connect = layer.codeConnect ?? { component: '', source: '', snippet: '' };
  const saveAsset = (targets: ExportTarget[]): void => {
    setExported('Exporting…');
    runExport(doc, targets, exportEnvironment(storage, images), layer.name)
      .then((out) => setExported(out.files.length === 0 ? (out.warnings[0] ?? 'Nothing was exported.') : `Exported ${out.files.map((file) => file.name).join(', ')}.`))
      .catch(() => setExported('The export failed.'));
  };
  const own = exportTargetsOf(doc, [layer.id]);
  return (
    <>
      <Section title={layer.name}>
        <Row>
          <span className="w-14 flex-none text-dim">Status</span>
          <select aria-label="Development status" className="od-field min-w-0 flex-1" value={layer.devStatus} onChange={(event) => store.getState().apply('Change development status', (d) => setDevStatus(d, [layer.id], event.currentTarget.value as DevStatus))}>
            {DEV_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </Row>
      </Section>
      {sections.map((section) => (
        <Section key={section.title} title={section.title}>
          <dl className="m-0 flex flex-col gap-1" aria-label={section.title}>
            {section.rows.map((row, index) => (
              <div key={index} className="flex items-start gap-2">
                <dt className="w-24 flex-none text-dim">{row.label}</dt>
                <dd className="m-0 flex min-w-0 flex-1 items-start gap-1.5 break-words">
                  {row.color && <span aria-hidden className="mt-0.5 h-3 w-3 flex-none rounded-sm border border-line" style={{ background: cssColor(row.color) }} />}
                  <span className="min-w-0 select-text">
                    {row.value}
                    {row.token && <span className="ml-1 rounded bg-field px-1 text-accent">{row.token}</span>}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      ))}
      <Section title="Code">
        <select aria-label="Code language" className="od-field" value={language} onChange={(event) => setLanguage(event.currentTarget.value as Language)}>
          {(Object.keys(LANGUAGE_LABELS) as Language[]).map((entry) => (
            <option key={entry} value={entry}>
              {LANGUAGE_LABELS[entry]}
            </option>
          ))}
        </select>
        <CodeBlock label={`${LANGUAGE_LABELS[language]} code`} code={code} />
        {language !== 'CSS' && <p className="m-0 text-faint">A starting point written from this layer’s properties: the nearest view and modifiers, not a finished screen.</p>}
      </Section>
      {(mapped || isComponent) && (
        <Section title="Component in code">
          {mapped && <CodeBlock label="Component code" code={mapped.code} />}
          {isComponent ? (
            <>
              <CommitInput label="Code component name" value={connect.component} className="w-full" placeholder="Name in code, for example Button" onCommit={(component) => store.getState().apply('Change code mapping', (d) => setCodeConnect(d, layer.id, { ...connect, component }))} />
              <CommitInput label="Code import source" value={connect.source} className="w-full" placeholder="Imported from, for example @acme/ui" onCommit={(source) => store.getState().apply('Change code mapping', (d) => setCodeConnect(d, layer.id, { ...connect, source }))} />
              <CommitInput
                label="Code snippet"
                value={connect.snippet}
                className="w-full"
                placeholder={'Snippet, for example <Button variant="{Type}" />'}
                onCommit={(snippet) => store.getState().apply('Change code mapping', (d) => setCodeConnect(d, layer.id, { ...connect, snippet }))}
              />
              <p className="m-0 text-faint">In the snippet, a property’s name in braces stands for the value an instance has for it.</p>
            </>
          ) : (
            <p className="m-0 text-faint">The mapping is set on the component.</p>
          )}
        </Section>
      )}
      <Section title="Assets">
        <Row>
          <button type="button" className="od-button !h-[26px] flex-1 !px-2" aria-label="Export as PNG" onClick={() => saveAsset(exportTargetsOf({ ...doc, nodes: { ...doc.nodes, [layer.id]: { ...layer, exportSettings: [newExportSetting()] } } }, [layer.id]))}>
            PNG
          </button>
          <button type="button" className="od-button !h-[26px] flex-1 !px-2" aria-label="Export as SVG" onClick={() => saveAsset(exportTargetsOf({ ...doc, nodes: { ...doc.nodes, [layer.id]: { ...layer, exportSettings: [newExportSetting({ format: 'SVG' })] } } }, [layer.id]))}>
            SVG
          </button>
          {own.length > 0 && (
            <button type="button" className="od-button !h-[26px] flex-1 !px-2" aria-label="Export with this layer's settings" onClick={() => saveAsset(own)}>
              Its {own.length} {own.length === 1 ? 'export' : 'exports'}
            </button>
          )}
        </Row>
        {exported && (
          <p role="status" aria-label="Asset export" className="m-0 text-dim">
            {exported}
          </p>
        )}
      </Section>
      <Section title="Annotations">
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {layer.annotations.map((annotation, index) => (
            <li key={annotation.id} className="flex items-center gap-1.5">
              <CommitInput label={`Annotation ${index + 1}`} value={annotation.text} onCommit={(text) => store.getState().apply('Change annotation', (d) => updateAnnotation(d, layer.id, annotation.id, text))} />
              <button type="button" className="od-icon-button flex-none" aria-label={`Remove annotation ${index + 1}`} title="Remove" onClick={() => store.getState().apply('Remove annotation', (d) => removeAnnotation(d, layer.id, annotation.id))}>
                <Icon name="close" />
              </button>
            </li>
          ))}
        </ul>
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (note.trim() === '') return;
            store.getState().apply('Add annotation', (d) => addAnnotation(d, layer.id, note.trim())?.doc ?? d);
            setNote('');
          }}
        >
          <input aria-label="New annotation" className="od-field min-w-0 flex-1" placeholder="A note for developers" value={note} onChange={(event) => setNote(event.currentTarget.value)} onKeyDown={(event) => event.stopPropagation()} />
          <button type="submit" className="od-button !h-[26px] flex-none !px-2" disabled={note.trim() === ''}>
            Add
          </button>
        </form>
      </Section>
      <Section title="Development resources">
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {layer.devResources.map((resource) => (
            <li key={resource.id} className="flex items-center gap-1.5">
              <a className="min-w-0 flex-1 truncate text-accent" href={safeUrl(resource.url) ?? undefined} target="_blank" rel="noreferrer noopener" title={resource.url}>
                {resource.name}
              </a>
              <button type="button" className="od-icon-button flex-none" aria-label={`Remove link ${resource.name}`} title="Remove" onClick={() => store.getState().apply('Remove link', (d) => removeDevResource(d, layer.id, resource.id))}>
                <Icon name="close" />
              </button>
            </li>
          ))}
        </ul>
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (safeUrl(link.url) === null) return;
            store.getState().apply('Add link', (d) => addDevResource(d, layer.id, link.name, link.url)?.doc ?? d);
            setLink({ name: '', url: '' });
          }}
        >
          <input aria-label="Link name" className="od-field" placeholder="Name, for example Storybook" value={link.name} onChange={(event) => setLink({ ...link, name: event.currentTarget.value })} onKeyDown={(event) => event.stopPropagation()} />
          <Row>
            <input aria-label="Link address" className="od-field min-w-0 flex-1" placeholder="https://…" value={link.url} onChange={(event) => setLink({ ...link, url: event.currentTarget.value })} onKeyDown={(event) => event.stopPropagation()} />
            <button type="submit" className="od-button !h-[26px] flex-none !px-2" disabled={safeUrl(link.url) === null}>
              Add
            </button>
          </Row>
        </form>
      </Section>
    </>
  );
}

function PageInspect() {
  const { store } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const pageId = useEditor((s) => s.pageId);
  const marked = useMemo(() => devStatusList(doc), [doc]);
  const notes = useMemo(() => annotationsOn(doc, pageId), [doc, pageId]);
  const go = (page: NodeId, layerId: NodeId): void => {
    store.getState().setPage(page);
    store.getState().setSelection([layerId]);
  };
  return (
    <>
      <Section title="Developer mode">
        <p className="m-0 text-dim">Select a layer to see its measurements, colours, type and code. Move the pointer over another layer to measure the distance to it. The canvas does not move or resize layers while this tab is open.</p>
      </Section>
      <Section title="Development status">
        {marked.length === 0 && <p className="m-0 text-faint">Nothing is marked yet. Select a frame and choose “Ready for development”.</p>}
        <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Marked for development">
          {marked.map(({ pageId: page, layer }) => (
            <li key={layer.id}>
              <button type="button" className="flex w-full items-center gap-2 border-0 bg-transparent p-0 text-left text-ink hover:text-accent" onClick={() => go(page, layer.id)}>
                <span className="min-w-0 flex-1 truncate">{layer.name}</span>
                <span className="flex-none text-dim">{STATUS_LABELS[layer.devStatus]}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Annotations on this page">
        {notes.length === 0 && <p className="m-0 text-faint">No annotations on this page.</p>}
        <ol className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Annotations on this page">
          {notes.map((placed) => (
            <li key={placed.annotation.id}>
              <button type="button" className="flex w-full items-start gap-2 border-0 bg-transparent p-0 text-left text-ink hover:text-accent" onClick={() => go(pageId, placed.layerId)}>
                <span className="flex-none text-dim">{placed.number}.</span>
                <span className="min-w-0 flex-1">
                  {placed.annotation.text} <span className="text-dim">({isLayer(doc.nodes[placed.layerId]) ? doc.nodes[placed.layerId]?.name : ''})</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}

export function InspectPanel() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const layers = selection.map((id) => doc.nodes[id]).filter(isLayer);
  return (
    <aside aria-label="Inspect" className="h-full overflow-y-auto" data-text-tools>
      {layers.length === 0 && <PageInspect />}
      {layers.length === 1 && <LayerInspect key={(layers[0] as LayerNode).id} layer={layers[0] as LayerNode} />}
      {layers.length > 1 && (
        <Section title="Inspect">
          <p className="m-0 text-faint">Select one layer to inspect it.</p>
        </Section>
      )}
    </aside>
  );
}
