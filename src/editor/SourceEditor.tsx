import { useEffect, useRef } from 'react';
import { EditorView, keymap, placeholder, Decoration, type DecorationSet } from '@codemirror/view';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { basicSetup } from 'codemirror';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { CompileDiagnostic } from '../compile/types';
import { tokens } from '../theme/tokens';

/**
 * `basicSetup` bundles a highlight style tuned for light backgrounds; on the
 * sunken surface most of its roles fall below AA. This overrides every role
 * this grammar produces, from tokens (each >=4.5:1 on `surface.sunken`).
 */
const syntaxTheme = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword], color: tokens.syntax.keyword, fontWeight: '600' },
  { tag: [t.comment], color: tokens.syntax.comment, fontStyle: 'italic' },
  { tag: [t.string, t.special(t.string)], color: tokens.syntax.string },
  { tag: [t.number], color: tokens.syntax.number },
  { tag: [t.bool, t.null], color: tokens.syntax.bool },
  { tag: [t.typeName, t.className, t.namespace], color: tokens.syntax.type },
  { tag: [t.propertyName], color: tokens.text.secondary },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: tokens.accent.primary },
  { tag: [t.variableName, t.definition(t.variableName)], color: tokens.text.primary },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: tokens.syntax.punctuation },
  { tag: [t.meta], color: tokens.text.muted },
  { tag: [t.invalid], color: tokens.status.danger, textDecoration: 'underline wavy' },
]);

const names = [
  'createProgram', 'encodeCall', 'rawCalldata', 'SELF', 'CALLER', 'GAS', 'TIMESTAMP', 'SELFBALANCE',
  'staticCall', 'call', 'if', 'balance', 'revertUnless', 'keccak', 'uint256', 'bytes32', 'bool', 'word',
  'add', 'sub', 'mul', 'div', 'lt', 'gt', 'eq',
];

function lisaCompletions(context: CompletionContext) {
  const word = context.matchBefore(/[\w$]*/);
  if (!word || (!context.explicit && word.from === word.to)) return null;
  return { from: word.from, options: names.map(label => ({ label, type: 'function' })) };
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

export function SourceEditor({ value, onChange, onCompile, diagnostic }: {
  value: string;
  onChange: (value: string) => void;
  onCompile: () => void;
  diagnostic?: CompileDiagnostic | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onCompileRef = useRef(onCompile);
  onChangeRef.current = onChange;
  onCompileRef.current = onCompile;

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
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '14px', backgroundColor: tokens.surface.sunken, color: tokens.text.primary },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
            '.cm-gutters': { backgroundColor: tokens.surface.sunken, color: tokens.text.muted, border: 'none' },
            '.cm-activeLine': { backgroundColor: `rgba(${tokens.accent.primaryRgb}, 0.07)` },
            '.cm-activeLineGutter': { backgroundColor: `rgba(${tokens.accent.primaryRgb}, 0.07)` },
            '.cm-cursor': { borderLeftColor: tokens.accent.primary },
            '.cm-selectionBackground': { backgroundColor: `rgba(${tokens.accent.primaryRgb}, 0.28) !important` },
            '.cm-lisa-error-line': { backgroundColor: `rgba(${tokens.status.dangerRgb}, 0.12)` },
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
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: setDiagnostic.of(diagnostic ?? null) });
  }, [diagnostic]);

  return <div ref={host} aria-label="LISA source editor" className="editor" />;
}
