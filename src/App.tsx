import { useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, Chip, CircularProgress, CssBaseline, IconButton, MenuItem, Paper, Select,
  Stack, Tab, Tabs, ThemeProvider, ToggleButton, ToggleButtonGroup, Typography, createTheme,
} from '@mui/material';
import { SourceEditor } from './editor/SourceEditor';
import { SOURCE_EXAMPLES, STARTER_SOURCE } from './editor/examples';
import { CompilerClient, CompilerError } from './compile/client';
import { createArtifact, parseArtifact, type ProgramArtifact } from './compile/artifact';
import type { CompileDiagnostic, CompileOutput } from './compile/types';
import { ContractsPanel } from './visual/ContractsPanel';
import { GraphError, generateVisualSource } from './visual/generate';
import { VisualCanvas, type CanvasApi } from './visual/VisualCanvas';
import {
  addContract, addNode, connectPort, removeContract, removeEdge, removeNodes,
  setNodeParent, setNodePosition, updateContract, updateNode,
} from './visual/projectState';
import { createId, emptyProject, type GraphNode, type GraphNodeDraft, type Vec2, type VisualProject } from './visual/model';
import { NodeInspector, VisualPalette } from './visual/NodePanel';
import { nodeSize, occupiedRects, spawnPosition } from './visual/spawnPosition';
import { loadStoredProject, saveStoredProject, type AuthoringMode } from './visual/storage';
import './styles.css';

const theme = createTheme({
  palette: { mode: 'dark', primary: { main: '#8ebdff' }, background: { default: '#0b1220', paper: '#172236' } },
  typography: { fontFamily: 'Inter, system-ui, sans-serif' },
  shape: { borderRadius: 10 },
});

function diagnosticFrom(error: unknown): CompileDiagnostic {
  if (error instanceof CompilerError) return error.diagnostic;
  return { message: error instanceof Error ? error.message : String(error) };
}

function diagnosticLabel(diagnostic: CompileDiagnostic) {
  return diagnostic.line
    ? `Line ${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ''}: ${diagnostic.message}`
    : diagnostic.message;
}

const DEFAULT_STORED = { version: 1 as const, mode: 'code' as AuthoringMode, codeSource: null, visual: emptyProject() };

export default function App() {
  const stored = useRef(loadStoredProject() ?? DEFAULT_STORED).current;
  const [mode, setMode] = useState<AuthoringMode>(stored.mode);
  const [source, setSource] = useState(stored.codeSource ?? STARTER_SOURCE);
  const [project, setProject] = useState<VisualProject>(stored.visual);
  const [output, setOutput] = useState<CompileOutput | null>(null);
  const [importedArtifact, setImportedArtifact] = useState<ProgramArtifact | null>(null);
  const [error, setError] = useState<CompileDiagnostic | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState(0);
  const [notice, setNotice] = useState('');
  const [generated, setGenerated] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [libraryTab, setLibraryTab] = useState(0);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [outputOpen, setOutputOpen] = useState(true);
  const client = useRef<CompilerClient | null>(null);
  const canvasApi = useRef<CanvasApi | null>(null);
  const revision = useRef(0);

  useEffect(() => () => client.current?.cancel(), []);
  useEffect(() => saveStoredProject({ version: 1, mode, codeSource: source, visual: project }), [mode, source, project]);

  function replaceSource(next: string, nextNotice = '') {
    if (next === source) {
      setNotice(nextNotice);
      return;
    }
    invalidateOutput();
    setSource(next);
    setNotice(nextNotice);
  }

  function invalidateOutput() {
    revision.current++;
    client.current?.cancel();
    setOutput(null);
    setImportedArtifact(null);
    setError(null);
    setGenerated('');
    setBusy(false);
  }

  /** Semantic graph edits invalidate compiled output; position edits do not. */
  function editVisual(transform: VisualProject | ((prev: VisualProject) => VisualProject), positional = false) {
    if (!positional) invalidateOutput();
    setProject(prev => typeof transform === 'function' ? transform(prev) : transform);
  }

  function addCallNode(contractId: string, signature: string, anchor: Vec2) {
    const id = createId(project.nodes.map(n => n.id), 'call');
    setFocusNodeId(id);
    editVisual(p => addNode(p, { id, kind: 'call', contractId, signature }, spawnNear(p, anchor, 'call')));
  }

  function moveNodes(changes: Readonly<Record<string, Vec2>>) {
    editVisual(p => Object.entries(changes).reduce(
      (next, [id, position]) => setNodePosition(next, id, position),
      p,
    ), true);
  }

  function addVisualNode(partial: GraphNodeDraft, prefix: string) {
    const id = createId(project.nodes.map(n => n.id), prefix);
    setFocusNodeId(id);
    editVisual(p => {
      const kind = (partial as GraphNode).kind;
      return addNode(p, { ...partial, id } as GraphNode, spawnNear(p, viewportCenter(), kind));
    });
  }

  /** One placement mechanism for every new node: visible-viewport spiral. */
  function spawnNear(p: VisualProject, anchor: Vec2, kind: GraphNode['kind']): Vec2 {
    return spawnPosition({
      anchor,
      size: nodeSize(kind),
      occupied: occupiedRects(p.nodes, p.positions),
      bounds: canvasApi.current?.viewportRect() ?? null,
    });
  }

  function viewportCenter(): Vec2 {
    return canvasApi.current?.viewportCenter() ?? { x: 320, y: 240 };
  }

  /** Click-to-add from the library: land the node in the visible viewport. */
  function addFunctionNode(contractId: string, signature: string) {
    addCallNode(contractId, signature, viewportCenter());
  }

  function editSelectedNode(patch: Record<string, unknown>) {
    if (!selectedId) return;
    if ('parent' in patch) {
      const parent = patch.parent as string | undefined;
      editVisual(p => setNodeParent(p, selectedId, parent));
    } else {
      editVisual(p => updateNode(p, selectedId, patch));
    }
  }

  async function compile() {
    const currentRevision = revision.current;
    const compiler = client.current ?? new CompilerClient();
    client.current = compiler;
    setBusy(true);
    setError(null);
    setNotice('');
    setOutput(null);
    setImportedArtifact(null);
    let programSource = source;
    if (mode === 'visual') {
      try {
        programSource = generateVisualSource(project);
      } catch (cause) {
        setBusy(false);
        setError({ message: graphMessage(cause) });
        return;
      }
      setGenerated(programSource);
    } else {
      setGenerated('');
    }
    try {
      const result = await compiler.compile(programSource);
      if (revision.current === currentRevision) setOutput(result);
    } catch (cause) {
      if (revision.current === currentRevision && (cause as Error).message !== 'Compilation cancelled') {
        setError(diagnosticFrom(cause));
      }
    } finally {
      if (revision.current === currentRevision) setBusy(false);
    }
  }

  function graphMessage(cause: unknown): string {
    if (cause instanceof GraphError) {
      const shown = cause.diagnostics.slice(0, 3)
        .map(d => (d.node ? `${d.node}: ${d.message}` : d.message));
      const rest = cause.diagnostics.length - shown.length;
      return shown.join(' · ') + (rest > 0 ? ` (and ${rest} more)` : '');
    }
    return cause instanceof Error ? cause.message : String(cause);
  }

  /** One-line state shown on the collapsed output bar. */
  function outputSummary() {
    if (error) return '⚠ failed';
    if (busy) return 'compiling…';
    if (output) return `✓ compiled · ${output.byteSize} bytes`;
    return 'idle';
  }

  async function importArtifact(file: File) {
    const currentRevision = revision.current;
    const compiler = client.current ?? new CompilerClient();
    client.current = compiler;
    setBusy(true);
    setError(null);
    setNotice('');
    setOutput(null);
    try {
      const artifact = parseArtifact(await file.text());
      const result = await compiler.inspect(artifact.program);
      if (revision.current === currentRevision) {
        setImportedArtifact(artifact);
        setOutput(result);
        setNotice(`Imported ${file.name} · ${artifact.compiler.name} ${artifact.compiler.version}`);
      }
    } catch (cause) {
      if (revision.current === currentRevision && (cause as Error).message !== 'Compilation cancelled') {
        setImportedArtifact(null);
        setError(diagnosticFrom(cause));
      }
    } finally {
      if (revision.current === currentRevision) setBusy(false);
    }
  }

  async function copy() {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output.program);
      setNotice('Bytecode copied');
    } catch {
      setNotice('Clipboard unavailable in this browser');
    }
  }

  function download() {
    if (!output) return;
    const artifact = importedArtifact ?? createArtifact(output);
    const blob = new Blob([JSON.stringify(artifact, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'lisa-program.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return <ThemeProvider theme={theme}>
    <CssBaseline />
    <Box className={mode === 'visual' ? 'app app-fixed' : 'app'}>
      <Stack className="topbar" direction="row" alignItems="center" justifyContent="space-between" gap={2}>
        <Box>
          <Typography variant="h5" fontWeight={700}>LISA IDE</Typography>
          <Typography variant="body2" color="text.secondary">Write, compile, and inspect LISA programs</Typography>
        </Box>
        <Stack direction="row" gap={1} flexWrap="wrap" justifyContent="flex-end" alignItems="center">
          <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_, next: 'code' | 'visual' | null) => {
            if (next && next !== mode) {
              invalidateOutput();
              setMode(next);
            }
          }} aria-label="Authoring mode">
            <ToggleButton value="code">Code</ToggleButton>
            <ToggleButton value="visual">Visual</ToggleButton>
          </ToggleButtonGroup>
          <Button variant="outlined" component="label" disabled={busy}>
            Import artifact
            <input
              hidden
              type="file"
              accept=".json,application/json"
              onChange={event => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void importArtifact(file);
              }}
            />
          </Button>
          <Button variant="contained" onClick={compile} disabled={busy} startIcon={busy ? <CircularProgress size={16} /> : undefined}>
            {busy ? 'Working…' : 'Compile'}
          </Button>
        </Stack>
      </Stack>
      {mode === 'code' ? <Box className="workspace">
        <Paper className="pane source-pane" elevation={0}>
          <Stack className="pane-heading" direction="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Typography variant="subtitle2">Source</Typography>
            <Stack direction="row" alignItems="center" gap={1}>
              <Select
                size="small"
                value=""
                displayEmpty
                aria-label="Load example"
                onChange={event => {
                  const example = SOURCE_EXAMPLES.find(candidate => candidate.id === event.target.value);
                  if (example) replaceSource(example.source, `Loaded example: ${example.label}`);
                }}
                sx={{ minWidth: 170 }}
              >
                <MenuItem value="" disabled>Load example…</MenuItem>
                {SOURCE_EXAMPLES.map(example => (
                  <MenuItem key={example.id} value={example.id}>{example.label}</MenuItem>
                ))}
              </Select>
              <Typography variant="caption" color="text.secondary">⌘ / Ctrl + Enter</Typography>
            </Stack>
          </Stack>
          <SourceEditor
            value={source}
            onChange={next => replaceSource(next)}
            onCompile={compile}
            diagnostic={error}
          />
        </Paper>
        <Paper className="pane output-pane" elevation={0}>
          <Box className="pane-heading"><Typography variant="subtitle2">Output</Typography></Box>
          <Box className="output-content">
            {renderOutput()}
          </Box>
        </Paper>
      </Box> : <Box className={`visual-workspace${libraryOpen ? '' : ' library-collapsed'}`}>
        <Paper className="pane canvas-pane" elevation={0}>
          <Box className="pane-heading"><Typography variant="subtitle2">Canvas</Typography></Box>
          <VisualCanvas
            canvasApi={canvasApi}
            project={project}
            onMoveNodes={moveNodes}
            onAddCallNode={addCallNode}
            onDeleteNodes={ids => {
              if (selectedId && ids.includes(selectedId)) setSelectedId(null);
              editVisual(p => removeNodes(p, ids));
            }}
            onDeleteEdges={ids => {
              if (selectedEdgeId && ids.includes(selectedEdgeId)) setSelectedEdgeId(null);
              editVisual(p => ids.reduce(removeEdge, p));
            }}
            onConnect={(from, to) => editVisual(p => connectPort(p, { from, to }))}
            onPatchNode={(id, fields) => editVisual(p => updateNode(p, id, fields))}
            onSelectNode={id => { setSelectedId(id); if (id !== null) setSelectedEdgeId(null); }}
            onSelectEdge={id => { setSelectedEdgeId(id); if (id !== null) setSelectedId(null); }}
            selectedNodeId={selectedId}
            selectedEdgeId={selectedEdgeId}
            focusNodeId={focusNodeId}
          />
        </Paper>
        <Paper className="pane side-pane" elevation={0}>
          <Stack className="pane-heading" direction="row" alignItems="center" justifyContent="space-between" gap={1}>
            {libraryOpen && <Typography variant="subtitle2">Library</Typography>}
            <IconButton size="small" aria-label={libraryOpen ? 'Collapse library' : 'Expand library'}
              onClick={() => setLibraryOpen(open => !open)} sx={{ p: 0.5 }}>
              <Typography variant="body2">{libraryOpen ? '⟩' : '⟨'}</Typography>
            </IconButton>
          </Stack>
          {libraryOpen && <>
            <Tabs value={libraryTab} onChange={(_, value: number) => setLibraryTab(value)} variant="fullWidth">
              <Tab label="Contracts" />
              <Tab label="Nodes" />
            </Tabs>
            <Box className="side-content">
              {libraryTab === 0 ? (
                <ContractsPanel
                  contracts={project.contracts}
                  onAddContract={contract => editVisual(p => addContract(p, contract))}
                  onUpdateContract={(id, patch) => editVisual(p => updateContract(p, id, patch))}
                  onRemoveContract={id => editVisual(p => removeContract(p, id))}
                  onAddFunction={addFunctionNode}
                />
              ) : (
                <VisualPalette onAdd={addVisualNode} />
              )}
              <Box className="side-section">
                <Typography variant="subtitle2">Selected node</Typography>
                <Box sx={{ mt: 0.5 }}>
                  <NodeInspector
                    node={project.nodes.find(n => n.id === selectedId) ?? null}
                    project={project}
                    onChange={editSelectedNode}
                  />
                </Box>
              </Box>
            </Box>
          </>}
        </Paper>
        <Paper className={`pane output-pane${outputOpen ? '' : ' output-collapsed'}`} elevation={0}>
          <Stack className="pane-heading" direction="row" alignItems="center" justifyContent="space-between" gap={1}>
            <Button size="small" onClick={() => setOutputOpen(open => !open)} aria-expanded={outputOpen}
              sx={{ justifyContent: 'flex-start', minWidth: 0 }}>
              {outputOpen ? '▾ Output' : '▸ Output'}
            </Button>
            {!outputOpen && <Typography variant="caption" color="text.secondary">{outputSummary()}</Typography>}
          </Stack>
          {outputOpen && <Box className="output-content">{renderOutput()}</Box>}
        </Paper>
      </Box>}
    </Box>
  </ThemeProvider>;

  function renderOutput() {
    const showGenerated = generated.length > 0;
    return <>
      {error && <Alert severity="error" sx={{ mb: 2, overflowWrap: 'anywhere' }}>{diagnosticLabel(error)}</Alert>}
      {notice && <Alert severity="info" sx={{ mb: 2 }}>{notice}</Alert>}
      {busy && <Typography color="text.secondary">Processing program…</Typography>}
      {!busy && !output && !error && <Typography color="text.secondary">Compile source or import an artifact to inspect the program.</Typography>}
      {output && <>
        <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mb: 2 }}>
          <Chip label={`${output.byteSize} bytes`} size="small" />
          <Chip label={`${output.instructionCount} instructions`} size="small" />
          {importedArtifact && <Chip label="Imported artifact" size="small" variant="outlined" />}
        </Stack>
        <Typography variant="caption" color="text.secondary">PROGRAM HASH</Typography>
        <Box className="hash">{output.programHash}</Box>
        <Tabs value={showGenerated ? tab : Math.min(tab, 1)} onChange={(_, value: number) => setTab(value)} sx={{ mt: 1 }}>
          <Tab label="Bytecode" />
          <Tab label="Disassembly" />
          {showGenerated && <Tab label="Generated source" />}
        </Tabs>
        {(showGenerated ? tab : Math.min(tab, 1)) === 0 && <Box component="pre" className="code-output" aria-label="Compiled bytecode">{output.program}</Box>}
        {(showGenerated ? tab : Math.min(tab, 1)) === 1 && <Box component="pre" className="code-output" aria-label="Disassembly">{output.disassembly.join('\n')}</Box>}
        {showGenerated && tab === 2 && <Box component="pre" className="code-output" aria-label="Generated source" title="Read-only: compiled directly from the graph">{generated}</Box>}
        <Stack direction="row" gap={1} sx={{ mt: 2 }} flexWrap="wrap">
          <Button variant="outlined" onClick={copy}>Copy bytecode</Button>
          <Button variant="outlined" onClick={download}>Export artifact</Button>
        </Stack>
      </>}
    </>;
  }
}
