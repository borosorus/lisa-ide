import { useEffect, useRef } from 'react';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { basicSetup } from 'codemirror';

const names = [
  'createProgram', 'encodeCall', 'rawCalldata', 'SELF', 'CALLER', 'GAS', 'TIMESTAMP', 'SELFBALANCE',
  'staticCall', 'call', 'if', 'uint256', 'bytes32', 'bool', 'word',
  'add', 'sub', 'mul', 'div', 'lt', 'gt', 'eq',
];

function lisaCompletions(context: CompletionContext) {
  const word = context.matchBefore(/[\w$]*/);
  if (!word || (!context.explicit && word.from === word.to)) return null;
  return { from: word.from, options: names.map(label => ({ label, type: 'function' })) };
}

export function SourceEditor({ value, onChange, onCompile }: {
  value: string;
  onChange: (value: string) => void;
  onCompile: () => void;
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
          javascript(),
          autocompletion({ override: [lisaCompletions] }),
          placeholder('Write a LISA program…'),
          keymap.of([{ key: 'Mod-Enter', run: () => { onCompileRef.current(); return true; } }]),
          EditorView.updateListener.of(update => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '14px', backgroundColor: '#101827', color: '#edf3fb' },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
            '.cm-gutters': { backgroundColor: '#152033', color: '#7790ad', border: 'none' },
            '.cm-activeLine': { backgroundColor: '#1b2940' },
            '.cm-activeLineGutter': { backgroundColor: '#1b2940' },
            '.cm-cursor': { borderLeftColor: '#9ccaff' },
            '.cm-selectionBackground': { backgroundColor: '#344c70 !important' },
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

  return <div ref={host} aria-label="LISA source editor" className="editor" />;
}
