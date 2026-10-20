import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorView, keymap, placeholder, Decoration, type DecorationSet } from '@codemirror/view';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { basicSetup } from 'codemirror';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { CompileDiagnostic } from '../compile/types';
import { tokens } from '../theme/tokens';

/** Explicit syntax colors keep language roles distinct and readable on the light editor surface. */
const syntaxTheme = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword], color: tokens.syntax.keyword, fontWeight: '600' },
  { tag: [t.comment], color: tokens.syntax.comment, fontStyle: 'italic' },
  { tag: [t.string, t.special(t.string)], color: tokens.syntax.string },
  { tag: [t.number], color: tokens.syntax.number },
  { tag: [t.bool, t.null], color: tokens.syntax.bool },
  { tag: [t.typeName, t.className, t.namespace], color: tokens.syntax.type },
  { tag: [t.propertyName], color: tokens.text.secondary },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: tokens.syntax.function },
  { tag: [t.variableName, t.definition(t.variableName)], color: tokens.text.primary },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: tokens.syntax.punctuation },
  { tag: [t.meta], color: tokens.text.muted },
  { tag: [t.invalid], color: tokens.status.danger, textDecoration: 'underline wavy' },
]);

const names = [
  'createProgram', 'encodeCall', 'rawCalldata', 'SELF', 'CALLER', 'GAS', 'TIMESTAMP', 'SELFBALANCE',
  'staticCall', 'call', 'tryStaticCall', 'tryCall', 'success', 'if', 'balance', 'revertUnless', 'keccak', 'uint256', 'bytes32', 'bool', 'word',
  'add', 'sub', 'mul', 'div', 'lt', 'gt', 'eq',
];

function lisaCompletions(context: CompletionContext) {
  const word = context.matchBefore(/[\w$]*/);
  if (!word || (!context.explicit && word.from === word.to)) return null;
  return { from: word.from, options: names.map(label => ({ label, type: label === 'success' ? 'property' : 'function' })) };
}

const setDiagnostic = StateEffect.define<CompileDiagnostic | null>();

function decorationsFor(state: EditorState, diagnostic: CompileDiagnostic | null): DecorationSet {
  if (!diagnostic?.line || diagnostic.line < 1 || diagnostic.line > state.doc.lines) return Decoration.none;
  const line = state.doc.line(diagnostic.line);
  const ranges = [
    Decoration.line({
      attributes: { class: 'cm-lisa-error-line', title: diagnostic.message },
    }).range(line.from),
  ];
  if (diagnostic.column) {
    const from = Math.min(line.to, line.from + Math.max(0, diagnostic.column - 1));
    if (from < line.to) {
      ranges.push(Decoration.mark({
        class: 'cm-lisa-error-char',
        attributes: { title: diagnostic.message },
      }).range(from, Math.min(line.to, from + 1)));
    }
  }
  return Decoration.set(ranges, true);
}

const diagnosticField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setDiagnostic)) next = decorationsFor(transaction.state, effect.value);
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field),
});

export interface SourceEditorHandle {
  /** Put the cursor on a 1-based line and center it — how an error becomes a place. */
  revealLine(line: number): void;
  /** Insert a library snippet at the current selection (or before `return p;` initially). */
  insertSnippet(snippet: string): void;
}

export const SourceEditor = forwardRef<SourceEditorHandle, {
  value: string;
  onChange: (value: string) => void;
  onCompile: () => void;
  diagnostic?: CompileDiagnostic | null;
}>(function SourceEditor({ value, onChange, onCompile, diagnostic }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onCompileRef = useRef(onCompile);
  const userPlacedCursor = useRef(false);
  onChangeRef.current = onChange;
  onCompileRef.current = onCompile;

  useImperativeHandle(ref, () => ({
    revealLine(line: number) {
      const editor = view.current;
      if (!editor) return;
      const target = Math.min(Math.max(1, Math.trunc(line)), editor.state.doc.lines);
      const pos = editor.state.doc.line(target).from;
      editor.dispatch({ selection: { anchor: pos, head: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      editor.focus();
    },
    insertSnippet(snippet: string) {
      const editor = view.current;
      if (!editor) return;
      let { from, to } = editor.state.selection.main;
      if (!userPlacedCursor.current) {
        const source = editor.state.doc.toString();
        const returnAt = source.match(/^[ \t]*return[ \t]+p[ \t]*;[ \t]*$/m);
        if (returnAt?.index !== undefined) {
          from = returnAt.index;
          to = from;
        }
      }
      const prefix = from > 0 && editor.state.doc.sliceString(from - 1, from) !== '\n' ? '\n' : '';
      const insert = `${prefix}${snippet}\n`;
      const cursor = from + insert.length;
      editor.dispatch({ changes: { from, to, insert }, selection: { anchor: cursor }, scrollIntoView: true });
      editor.focus();
      userPlacedCursor.current = true;
    },
  }), []);

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          syntaxHighlighting(syntaxTheme, { fallback: true }),
          javascript(),
          autocompletion({ override: [lisaCompletions] }),
          placeholder('Write a LISA program…'),
          diagnosticField,
          keymap.of([{ key: 'Mod-Enter', run: () => { onCompileRef.current(); return true; } }]),
          EditorView.updateListener.of(update => {
            if (update.selectionSet || update.focusChanged) userPlacedCursor.current = true;
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '14px', backgroundColor: tokens.surface.sunken, color: tokens.text.primary },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
            '.cm-gutters': { backgroundColor: tokens.surface.sunken, color: tokens.text.muted, border: 'none' },
            '.cm-activeLine': { backgroundColor: `rgba(${tokens.accent.primaryRgb}, 0.04)` },
            '.cm-activeLineGutter': { backgroundColor: `rgba(${tokens.accent.primaryRgb}, 0.04)` },
            '.cm-cursor': { borderLeftColor: tokens.accent.primary },
            // The standard text selection is easy to miss during long-press
            // selection on touch screens; use a saturated blue tint with
            // enough contrast against both the editor surface and syntax colors.
            '.cm-selectionBackground': { backgroundColor: `rgba(${tokens.accent.secondaryRgb}, 0.34) !important` },
            '&.cm-focused .cm-selectionBackground': { backgroundColor: `rgba(${tokens.accent.secondaryRgb}, 0.42) !important` },
            '.cm-content ::selection': {
              backgroundColor: `rgba(${tokens.accent.secondaryRgb}, 0.42) !important`,
              color: `${tokens.text.primary} !important`,
            },
            '.cm-placeholder': { color: tokens.text.muted },
            '.cm-tooltip': {
              backgroundColor: tokens.surface.paper,
              color: tokens.text.primary,
              border: `1px solid ${tokens.border.strong}`,
              borderRadius: '8px',
              boxShadow: `0 8px 24px rgba(${tokens.text.primaryRgb}, 0.14)`,
            },
            '.cm-tooltip-autocomplete ul li': { color: tokens.text.primary, padding: '3px 8px' },
            '.cm-tooltip-autocomplete ul li[aria-selected]': {
              color: tokens.accent.primary,
              backgroundColor: `rgba(${tokens.accent.primaryRgb}, 0.12)`,
            },
            '.cm-completionMatched': { color: tokens.accent.secondary, fontWeight: '700' },
            // Keep the diagnostic visible without tinting the code beneath
            // selections; the character underline and narrow line marker do that.
            '.cm-lisa-error-line': { boxShadow: `inset 3px 0 0 rgba(${tokens.status.dangerRgb}, 0.72)` },
            '.cm-lisa-error-char': { textDecoration: `underline wavy ${tokens.status.danger}`, textUnderlineOffset: '3px' },
          }),
        ],
      }),
      parent: host.current,
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      // A loaded example/project replaces the editor document outside the
      // user's insertion point. Let the next library click use the safe
      // before-return fallback instead of a stale mapped cursor.
      userPlacedCursor.current = false;
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: setDiagnostic.of(diagnostic ?? null) });
  }, [diagnostic]);

  return <div ref={host} aria-label="LISA source editor" className="editor" />;
});
