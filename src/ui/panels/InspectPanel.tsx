import { useMemo, useState } from 'react';
import {
  addAnnotation,
  approximateMeasurer,
  addDevResource,
  annotationsOn,
  codeConnectFor,
  composeFor,
  cssColor,
  cssFor,
  DEV_STATUSES,
  devStatusList,
  exportTargetsOf,
  getWorldMatrix,
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
  type Document,
  type ExportTarget,
  type LayerNode,
  type NodeId,
} from '../../core';
import { distanceToFrame } from '../../core/dev/inspect';
import { composeScreenFor, hasScreenCode, htmlPageFor, swiftScreenFor } from '../../core/dev/screen';
import { exportSvg } from '../../engine/export/svg';
import { buildVectorScene } from '../../engine/export/vector';
import { getBrowserMeasurer } from '../../engine/text/measure';
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
/** What the code is written for: the selected layer alone, or it with everything in it. */
type Scope = 'LAYER' | 'FRAME';
const SCOPE_LABELS: Record<Scope, string> = { LAYER: 'This layer', FRAME: 'Whole frame' };
const SCREEN_LABELS: Record<Language, string> = { CSS: 'HTML and CSS', SWIFT: 'iOS (SwiftUI)', COMPOSE: 'Android (Compose)' };

/** A layer drawn by the export engine as an SVG element in its own box: how a whole frame's HTML shows vectors and other drawings. */
function svgOfLayer(doc: Document, id: NodeId): string | null {
  const node = doc.nodes[id];
  if (!isLayer(node)) return null;
  const at = getWorldMatrix(doc, id);
  const scene = buildVectorScene(doc, [id], { measurer: getBrowserMeasurer() ?? approximateMeasurer, origin: { x: at[4], y: at[5] } });
  return exportSvg(scene, { width: node.width, height: node.height }).svg;
}

/** The code for a layer with everything in it, in one language. */
function screenCode(doc: Document, id: NodeId, language: Language): string {
  if (language === 'CSS') return htmlPageFor(doc, id, { svgFor: (layerId) => svgOfLayer(doc, layerId) });
  return language === 'SWIFT' ? swiftScreenFor(doc, id) : composeScreenFor(doc, id);
}

/** How far a layer is from each edge of its frame, drawn as Dev Mode draws it: the four distances round a box. */
function FrameDistances({ distances }: { distances: { frameName: string; left: number; top: number; right: number; bottom: number } }) {
  const value = (label: string, amount: number) => (
    <span aria-label={`${label}: ${amount}px`} className="select-text tabular-nums text-ink">
      {amount}
    </span>
  );
  return (
    <div role="group" aria-label={`Distance to the edges of ${distances.frameName}`} className={`grid grid-cols-[1fr_auto_1fr] grid-rows-[auto_auto_auto] items-center justify-items-center gap-1 px-3 py-2.5 ${WELL}`}>
      <span className="col-start-2 row-start-1">{value('Top', distances.top)}</span>
      <span className="col-start-1 row-start-2 justify-self-end">{value('Left', distances.left)}</span>
      <span aria-hidden="true" className="col-start-2 row-start-2 h-6 w-16 rounded-[4px] border border-accent bg-selected" />
      <span className="col-start-3 row-start-2 justify-self-start">{value('Right', distances.right)}</span>
      <span className="col-start-2 row-start-3">{value('Bottom', distances.bottom)}</span>
    </div>
  );
}

/** A rounded well pressed into the panel: what code and measurements sit in. */
const WELL = 'rounded-[10px] bg-bg/50 shadow-[var(--ev-sunk)]';
/** What an empty list says, in a quiet dashed outline where its rows would be. */
const EMPTY = 'm-0 rounded-[8px] border border-dashed border-line px-3 py-2.5 text-center leading-[1.45] text-faint';
/** A note under the controls it is about. */
const NOTE = 'm-0 leading-[1.45] text-faint';
/** A row of a list that takes you somewhere: Figma's list row, lit on hover. */
const LINK_ROW = 'ev-row flex w-full rounded-[6px] border-0 bg-transparent px-1.5 text-left text-ink hover:bg-hover';

function copyText(text: string, done: () => void): void {
  if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).then(done, () => undefined);
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    // The code in a well, as Dev Mode shows it, with its copy button on a strip along the foot.
    <div className={`flex flex-col ${WELL}`}>
      <pre aria-label={label} tabIndex={0} className="m-0 max-h-64 select-text overflow-auto whitespace-pre rounded-t-[10px] px-3 py-2.5 font-mono text-[11px] leading-[1.65] text-ink focus-visible:-outline-offset-2">
        {code}
      </pre>
      <div className="flex items-center justify-end border-t border-line/70 p-1">
        <button
          type="button"
          className="ev-button !h-6 !gap-1 !rounded-[7px] !px-2 text-[11px]"
          onClick={() =>
            copyText(code, () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied && (
            <span aria-hidden="true" className="flex text-accent">
              <Icon name="check" size={12} />
            </span>
          )}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function LayerInspect({ layer }: { layer: LayerNode }) {
  const { store, storage, images } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const [language, setLanguage] = useState<Language>('CSS');
  const [scope, setScope] = useState<Scope>('LAYER');
  const [note, setNote] = useState('');
  const [link, setLink] = useState({ name: '', url: '' });
  const [exported, setExported] = useState('');
  const sections = useMemo(() => inspectLayer(doc, layer.id), [doc, layer.id]);
  const whole = scope === 'FRAME' && hasScreenCode(doc, layer.id);
  const code = useMemo(
    () => (whole ? screenCode(doc, layer.id, language) : language === 'CSS' ? cssFor(doc, layer.id) : language === 'SWIFT' ? swiftFor(doc, layer.id) : composeFor(doc, layer.id)),
    [doc, layer.id, language, whole],
  );
  const toFrame = useMemo(() => distanceToFrame(doc, layer.id), [doc, layer.id]);
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
          <select aria-label="Development status" className="ev-field min-w-0 flex-1" value={layer.devStatus} onChange={(event) => store.getState().apply('Change development status', (d) => setDevStatus(d, [layer.id], event.currentTarget.value as DevStatus))}>
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
          {/* Label and value in pairs, like a spec sheet: one hairline between each. */}
          <dl className={`m-0 flex flex-col divide-y divide-line/60 px-2.5 py-0.5 ${WELL}`} aria-label={section.title}>
            {section.rows.map((row, index) => (
              <div key={index} className="flex items-start gap-2 py-[6px]">
                <dt className="w-[84px] flex-none text-dim">{row.label}</dt>
                <dd className="m-0 flex min-w-0 flex-1 items-start gap-1.5 break-words text-ink">
                  {row.color && <span aria-hidden className="mt-px h-3.5 w-3.5 flex-none rounded-[4px] border border-line" style={{ background: cssColor(row.color) }} />}
                  <span className="min-w-0 select-text tabular-nums">
                    {row.value}
                    {row.token && <span className="ml-1.5 rounded-[5px] bg-selected px-1.5 py-px text-[11px] font-medium text-accent">{row.token}</span>}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      ))}
      {toFrame && toFrame.frameId !== layer.parentId && (
        // When the layer is in a group, the edges of the frame round it are not those of its parent.
        <Section title="Distance to the frame's edges">
          <FrameDistances distances={toFrame} />
          <p className={NOTE}>To the edges of {toFrame.frameName}.</p>
        </Section>
      )}
      <Section title="Code">
        {hasScreenCode(doc, layer.id) && (
          <div role="radiogroup" aria-label="Code for" className="ev-segmented">
            {(Object.keys(SCOPE_LABELS) as Scope[]).map((entry) => (
              <button
                key={entry}
                type="button"
                role="radio"
                aria-checked={scope === entry}
                className={`h-6 min-w-0 flex-1 cursor-pointer rounded-[7px] border-0 font-medium transition-[color,background-color,box-shadow] duration-150 ${scope === entry ? 'bg-[image:var(--ev-button)] text-ink shadow-[var(--ev-raise)]' : 'bg-transparent text-dim hover:text-ink'}`}
                onClick={() => setScope(entry)}
              >
                {SCOPE_LABELS[entry]}
              </button>
            ))}
          </div>
        )}
        <select aria-label="Code language" className="ev-field" value={language} onChange={(event) => setLanguage(event.currentTarget.value as Language)}>
          {(Object.keys(LANGUAGE_LABELS) as Language[]).map((entry) => (
            <option key={entry} value={entry}>
              {LANGUAGE_LABELS[entry]}
            </option>
          ))}
        </select>
        <CodeBlock label={whole ? `${SCREEN_LABELS[language]} code for the whole frame` : `${LANGUAGE_LABELS[language]} code`} code={code} />
        {whole ? (
          <p className={NOTE}>{language === 'CSS' ? 'Every layer in it as an element with a class named after it: Auto Layout as flexbox, other layers placed absolutely, vectors as inline SVG, images by their file name.' : 'Every layer in it, nested as it is in the design: Auto Layout as stacks with their spacing and padding, other layers moved to their places. Vectors and images are named as assets to export.'}</p>
        ) : (
          language !== 'CSS' && <p className={NOTE}>A starting point written from this layer’s properties: the nearest view and modifiers, not a finished screen.</p>
        )}
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
              <p className={NOTE}>In the snippet, a property’s name in braces stands for the value an instance has for it.</p>
            </>
          ) : (
            <p className={NOTE}>The mapping is set on the component.</p>
          )}
        </Section>
      )}
      <Section title="Assets">
        <Row>
          <button type="button" className="ev-button !h-7 flex-1 !px-2" aria-label="Export as PNG" onClick={() => saveAsset(exportTargetsOf({ ...doc, nodes: { ...doc.nodes, [layer.id]: { ...layer, exportSettings: [newExportSetting()] } } }, [layer.id]))}>
            PNG
          </button>
          <button type="button" className="ev-button !h-7 flex-1 !px-2" aria-label="Export as SVG" onClick={() => saveAsset(exportTargetsOf({ ...doc, nodes: { ...doc.nodes, [layer.id]: { ...layer, exportSettings: [newExportSetting({ format: 'SVG' })] } } }, [layer.id]))}>
            SVG
          </button>
          {own.length > 0 && (
            <button type="button" className="ev-button !h-7 flex-1 !px-2" aria-label="Export with this layer's settings" onClick={() => saveAsset(own)}>
              Its {own.length} {own.length === 1 ? 'export' : 'exports'}
            </button>
          )}
        </Row>
        {exported && (
          <p role="status" aria-label="Asset export" className="m-0 break-words leading-[1.45] text-dim">
            {exported}
          </p>
        )}
      </Section>
      <Section title="Annotations">
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 empty:hidden">
          {layer.annotations.map((annotation, index) => (
            <li key={annotation.id} className="flex items-center gap-1.5">
              <CommitInput label={`Annotation ${index + 1}`} value={annotation.text} onCommit={(text) => store.getState().apply('Change annotation', (d) => updateAnnotation(d, layer.id, annotation.id, text))} />
              <button type="button" className="ev-icon-button flex-none" aria-label={`Remove annotation ${index + 1}`} title="Remove" onClick={() => store.getState().apply('Remove annotation', (d) => removeAnnotation(d, layer.id, annotation.id))}>
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
          <input aria-label="New annotation" className="ev-field min-w-0 flex-1" placeholder="A note for developers" value={note} onChange={(event) => setNote(event.currentTarget.value)} onKeyDown={(event) => event.stopPropagation()} />
          <button type="submit" className="ev-button !h-7 flex-none !px-3" disabled={note.trim() === ''}>
            Add
          </button>
        </form>
      </Section>
      <Section title="Development resources">
        <ul className={`m-0 flex list-none flex-col p-0.5 empty:hidden ${WELL}`}>
          {layer.devResources.map((resource) => (
            <li key={resource.id} className="ev-row flex h-7 items-center gap-1.5 rounded-[7px] pl-2 hover:bg-hover">
              <a className="min-w-0 flex-1 truncate text-accent underline-offset-2 hover:underline" href={safeUrl(resource.url) ?? undefined} target="_blank" rel="noreferrer noopener" title={resource.url}>
                {resource.name}
              </a>
              <button type="button" className="ev-icon-button flex-none" aria-label={`Remove link ${resource.name}`} title="Remove" onClick={() => store.getState().apply('Remove link', (d) => removeDevResource(d, layer.id, resource.id))}>
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
          <input aria-label="Link name" className="ev-field" placeholder="Name, for example Storybook" value={link.name} onChange={(event) => setLink({ ...link, name: event.currentTarget.value })} onKeyDown={(event) => event.stopPropagation()} />
          <Row>
            <input aria-label="Link address" className="ev-field min-w-0 flex-1" placeholder="https://…" value={link.url} onChange={(event) => setLink({ ...link, url: event.currentTarget.value })} onKeyDown={(event) => event.stopPropagation()} />
            <button type="submit" className="ev-button !h-7 flex-none !px-3" disabled={safeUrl(link.url) === null}>
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
        <p className={`m-0 px-3 py-2.5 leading-[1.5] text-dim ${WELL}`}>Select a layer to see its measurements, colours, type and code. Move the pointer over another layer to measure the distance to it. The canvas does not move or resize layers while this tab is open.</p>
      </Section>
      <Section title="Development status">
        {marked.length === 0 && <p className={EMPTY}>Nothing is marked yet. Select a frame and choose “Ready for development”.</p>}
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label="Marked for development">
          {marked.map(({ pageId: page, layer }) => (
            <li key={layer.id} className="-mx-1.5">
              <button type="button" className={`${LINK_ROW} h-7 items-center gap-2`} onClick={() => go(page, layer.id)}>
                <span aria-hidden="true" className={`h-1.5 w-1.5 flex-none rounded-full ${layer.devStatus === 'COMPLETED' ? 'bg-success' : 'bg-accent'}`} />
                <span className="min-w-0 flex-1 truncate">{layer.name}</span>
                <span className="flex-none text-[11px] text-dim">{STATUS_LABELS[layer.devStatus]}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Annotations on this page">
        {notes.length === 0 && <p className={EMPTY}>No annotations on this page.</p>}
        <ol className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label="Annotations on this page">
          {notes.map((placed) => (
            <li key={placed.annotation.id} className="-mx-1.5">
              <button type="button" className={`${LINK_ROW} items-start gap-2 py-1.5 leading-[1.45]`} onClick={() => go(pageId, placed.layerId)}>
                <span className="min-w-4 flex-none text-right tabular-nums text-dim">{placed.number}.</span>
                <span className="min-w-0 flex-1 break-words">
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
          <p className={EMPTY}>Select one layer to inspect it.</p>
        </Section>
      )}
    </aside>
  );
}
