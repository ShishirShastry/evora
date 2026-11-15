import { useLayoutEffect, useRef } from 'react';
import {
  approximateMeasurer,
  deleteNodes,
  fontString,
  getWorldMatrix,
  isText,
  layoutText,
  paintColor,
  patchNode,
  resolveLineHeight,
  setTextCharacters,
  textLayerName,
  type Document,
  type NodeId,
} from '../../core';
import { rgbToCss } from '../../engine/render/paint';
import { getBrowserMeasurer } from '../../engine/text/measure';
import { useEditor, useEditorContext } from './EditorContext';

interface TextEditorProps {
  id: NodeId;
  /** Called when editing ends, so the canvas can take the keyboard focus back. */
  onDone: () => void;
}

const TEXT_TRANSFORM = { ORIGINAL: 'none', UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' } as const;

/**
 * Edits a text layer in place. A real text field is laid exactly over the
 * layer (same font, size, spacing, rotation and zoom) while the canvas hides
 * the layer's own rendering, so the browser provides caret, selection, IME
 * and clipboard. Every keystroke updates the document inside one gesture;
 * finishing commits it as a single undo step.
 */
export function TextEditor({ id, onDone }: TextEditorProps) {
  const { store } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const viewport = useEditor((s) => s.viewport);
  const ref = useRef<HTMLTextAreaElement>(null);
  /** The document the edit started from, and whether this edit is creating the layer. */
  const session = useRef<{ base: Document; created: boolean; finished: boolean } | null>(null);
  const node = doc.nodes[id];

  useLayoutEffect(() => {
    const state = store.getState();
    // The text tool leaves its gesture open: the layer then exists now but not in the gesture's snapshot.
    const created = state.gesture !== null && !state.gesture.doc.nodes[id];
    state.beginGesture();
    session.current = { base: store.getState().doc, created, finished: false };
    const field = ref.current;
    if (field) {
      field.focus({ preventScroll: true });
      field.select();
    }
  }, [store, id]);

  const finish = (): void => {
    const current = session.current;
    if (!current || current.finished) return;
    current.finished = true;
    const state = store.getState();
    const edited = state.doc.nodes[id];
    const original = current.base.nodes[id];

    if (!isText(edited) || !state.gesture) {
      state.cancelGesture();
    } else if (edited.characters.trim() === '') {
      // Empty text is not kept: a new layer vanishes without a trace, an existing one is deleted.
      if (current.created) state.cancelGesture();
      else {
        state.updateGesture(() => deleteNodes(current.base, [id]), []);
        store.getState().commitGesture('Delete text');
      }
    } else {
      // The layer is named after its text until the user gives it a name of their own.
      const namedByContent =
        current.created || !isText(original) || original.name === textLayerName(original.characters) || /^Text \d+$/.test(original.name);
      if (namedByContent) {
        const name = textLayerName(edited.characters);
        const now = state.doc;
        state.updateGesture(() => patchNode(now, id, { name }));
      }
      store.getState().commitGesture(current.created ? 'Create text' : 'Edit text');
    }
    store.getState().setEditingText(null);
    onDone();
  };

  if (!isText(node)) return null;

  const m = getWorldMatrix(doc, id);
  const z = viewport.zoom;
  const lineHeight = resolveLineHeight(node);
  const autoWidth = node.textAutoResize === 'WIDTH_AND_HEIGHT';
  const fill = node.fills.find((paint) => paint.visible);
  // A list's text is set in from the left to make room for its markers, which are not shown while typing.
  const indent = layoutText(node, getBrowserMeasurer() ?? approximateMeasurer).indent;

  return (
    <textarea
      ref={ref}
      aria-label="Edit text"
      value={node.characters}
      spellCheck={false}
      wrap={autoWidth ? 'off' : 'soft'}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        zIndex: 5,
        transformOrigin: '0 0',
        transform: `matrix(${m[0] * z}, ${m[1] * z}, ${m[2] * z}, ${m[3] * z}, ${(m[4] - viewport.x) * z}, ${(m[5] - viewport.y) * z})`,
        // A little slack keeps left-aligned auto-width text from scrolling while a character is being measured.
        width: autoWidth && node.textAlign === 'LEFT' ? node.width + Math.ceil(node.fontSize) : Math.max(1, node.width),
        height: Math.max(node.height, lineHeight),
        font: fontString(node),
        lineHeight: `${lineHeight}px`,
        letterSpacing: `${node.letterSpacing}px`,
        textAlign: node.textAlign === 'JUSTIFIED' ? 'justify' : (node.textAlign.toLowerCase() as 'left' | 'center' | 'right'),
        boxSizing: 'border-box',
        paddingLeft: indent,
        textTransform: TEXT_TRANSFORM[node.textCase],
        textDecoration: node.textDecoration === 'UNDERLINE' ? 'underline' : node.textDecoration === 'STRIKETHROUGH' ? 'line-through' : 'none',
        // A gradient fill is shown in its first colour while typing.
        color: fill ? rgbToCss(paintColor(fill), fill.opacity) : 'transparent',
        caretColor: fill ? rgbToCss(paintColor(fill)) : 'var(--od-accent)',
        whiteSpace: autoWidth ? 'pre' : 'pre-wrap',
        overflow: 'hidden',
        resize: 'none',
        border: 0,
        paddingTop: 0,
        paddingRight: 0,
        paddingBottom: 0,
        margin: 0,
        background: 'transparent',
        outline: '1px solid var(--od-accent)',
        outlineOffset: 1,
      }}
      onChange={(event) => {
        const characters = event.currentTarget.value;
        const current = session.current;
        if (!current || current.finished) return;
        // Another edit (for example a font change in the panel) may have closed the gesture: open a new one.
        if (!store.getState().gesture) {
          store.getState().beginGesture();
          current.base = store.getState().doc;
          current.created = false;
        }
        const base = current.base;
        // Styled parts stay on the characters they were on.
        store.getState().updateGesture(() => setTextCharacters(base, id, characters));
      }}
      onBlur={finish}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) {
          event.preventDefault();
          finish();
        }
        // Keep editor shortcuts from firing while typing.
        event.stopPropagation();
      }}
      onPointerDown={(event) => event.stopPropagation()}
    />
  );
}
