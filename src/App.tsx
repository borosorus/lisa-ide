import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box, Button, CircularProgress, CssBaseline, GlobalStyles, IconButton, MenuItem, Paper, Select,
  Snackbar, Stack, Tab, Tabs, ThemeProvider, Typography,
} from '@mui/material';
import BoltRoundedIcon from '@mui/icons-material/BoltRounded';

import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded';
import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import TerminalRoundedIcon from '@mui/icons-material/TerminalRounded';
import DescriptionRoundedIcon from '@mui/icons-material/DescriptionRounded';
import DashboardRoundedIcon from '@mui/icons-material/DashboardRounded';
import LibraryBooksRoundedIcon from '@mui/icons-material/LibraryBooksRounded';
import WarningRoundedIcon from '@mui/icons-material/WarningRounded';
import { SourceEditor, type SourceEditorHandle } from './editor/SourceEditor';
import { SOURCE_EXAMPLES, STARTER_SOURCE } from './editor/examples';
import { CompilerClient, CompilerError } from './compile/client';
import { createArtifact, parseArtifact, type ProgramArtifact } from './compile/artifact';
import type { CompileDiagnostic, CompileOutput } from './compile/types';
import { ContractsPanel } from './visual/ContractsPanel';
import { GraphError, generateVisualSource } from './visual/generate';
import { VisualCanvas, type CanvasApi } from './visual/VisualCanvas';
import {
  addContract, addNode, connectPort, enableElse, moveGraphNodes, removeContract, removeEdge, removeNodes,
  setNodeFrameSize, updateContract, updateNode,
} from './visual/projectState';
import { createId, emptyProject, type GraphNode, type GraphNodeDraft, type ScopeTarget, type Vec2, type VisualProject } from './visual/model';
import { NodeInspector, VisualPalette } from './visual/NodePanel';
import { nodeSize, spawnPosition } from './visual/spawnPosition';
import { occupiedRects, resolveNodeDrop, spawnInsideIf } from './visual/containment';
import { validateProject } from './visual/validate';
import { loadStoredProject, saveStoredProject, type AuthoringMode } from './visual/storage';
import { WalletExecutionPanel } from './wallet/WalletExecutionPanel';
import { ExecuteBlocks, ExecuteButton } from './wallet/ExecuteActions';
import { ExecutionDialog } from './wallet/ExecutionDialog';
import { useWalletExecution } from './wallet/useWalletExecution';
import { Toolbar } from './shell/Toolbar';
import { OutputPanel } from './shell/OutputPanel';
import { cssVarStyles, theme } from './theme/theme';
import './styles.css';

function diagnosticFrom(error: unknown): CompileDiagnostic {
  if (error instanceof CompilerError) return error.diagnostic;
  return { message: error instanceof Error ? error.message : String(error) };
}

const DEFAULT_STORED = { version: 1 as const, mode: 'code' as AuthoringMode, codeSource: null, visual: emptyProject() };

/** Pane heading: a quiet icon carrying the eye to what the pane is for. */
function PaneTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
    <Box className="pane-title-icon" aria-hidden="true">{icon}</Box>
    <Typography variant="subtitle2" noWrap>{children}</Typography>
  </Stack>;
}

export default function App() {
  const stored = useRef(loadStoredProject() ?? DEFAULT_STORED).current;
  const [mode, setMode] = useState<AuthoringMode>(stored.mode);
  const [source, setSource] = useState(stored.codeSource ?? STARTER_SOURCE);
  const [project, setProject] = useState<VisualProject>(stored.visual);
  const [output, setOutput] = useState<CompileOutput | null>(null);
  const [importedArtifact, setImportedArtifact] = useState<ProgramArtifact | null>(null);
  const [error, setError] = useState<CompileDiagnostic | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [generated, setGenerated] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  // UI-only spawn target: the branch region last clicked (§9). Cleared with
  // the node selection; never persisted, never read by lowering.
  const [selectedBranch, setSelectedBranch] = useState<{ nodeId: string; branch: 'then' | 'else' } | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [libraryTab, setLibraryTab] = useState(0);
  const [libraryOpen, setLibraryOpen] = useState(true);
  // One-deep, single-slot undo for graph deletions: a hand-built graph can lose
  // minutes of wiring to one Delete keypress, and that keystroke is silent.
  const [undo, setUndo] = useState<{ snapshot: VisualProject; message: string } | null>(null);
  // Lets a deletion's own editVisual pass through without voiding the slot it just filled.
  const keepUndoSlot = useRef(false);
  // Visual mode gives the canvas the space: Output starts collapsed there.
  const [outputOpen, setOutputOpen] = useState(stored.mode !== 'visual');
  useEffect(() => { setOutputOpen(mode !== 'visual'); }, [mode]);
  // Errors are otherwise invisible behind a collapsed panel; open to reveal.
  useEffect(() => { if (error) setOutputOpen(true); }, [error]);
  const client = useRef<CompilerClient | null>(null);
  const canvasApi = useRef<CanvasApi | null>(null);
  const editorRef = useRef<SourceEditorHandle | null>(null);
  const revision = useRef(0);

  useEffect(() => () => client.current?.dispose(), []);
  useEffect(() => saveStoredProject({ version: 1, mode, codeSource: source, visual: project }), [mode, source, project]);
  // One pure validation pass feeds both the canvas error states and compile.
  const diagnostics = useMemo(() => validateProject(project), [project]);

  /*
   * Only output the current source compiled to is executable. An imported
   * artifact populates the same inspectors and the same Output panel, but its
   * source is not in front of the user, so it never reaches the sender (§4).
   * The Execute action follows the program into the Output pane's own header
   * — expanded or collapsed, code or visual — so the action is never behind
   * a toggle; what the user verifies before a broadcast is a centered window.
   */
  const execution = useWalletExecution(importedArtifact === null ? output : null);
  // Mounted in exactly one header at a time: the mode branch and the collapse
  // state decide, and both cannot show simultaneously.
  const executeSlot = <ExecuteButton execution={execution} />;

  function replaceSource(next: string, nextNotice = '') {
    if (next === source) {
      if (nextNotice !== '') setNotice(nextNotice);
      return;
    }
    invalidateOutput();
    setSource(next);
    // An empty notice means "keep whatever explanation is showing"; an
    // explicit one (a loaded example) replaces it.
    if (nextNotice !== '') setNotice(nextNotice);
  }

  function invalidateOutput() {
    revision.current++;
    client.current?.cancel();
    // A visible result that vanishes because its input moved should say so;
    // silently reverting to "idle" reads as a glitch.
    if (output !== null || importedArtifact !== null) {
      setNotice('Previous output cleared — the source or graph behind it changed.');
    }
    setOutput(null);
    setImportedArtifact(null);
    setError(null);
    setGenerated('');
    setBusy(false);
  }

  /** Semantic graph edits invalidate compiled output; position edits do not. */
  function editVisual(transform: VisualProject | ((prev: VisualProject) => VisualProject), positional = false) {
    if (!positional) invalidateOutput();
    // Any graph edit other than a deletion voids that deletion's undo slot:
    // restoring the snapshot would silently discard the later work.
    if (keepUndoSlot.current) keepUndoSlot.current = false;
    else setUndo(null);
    setProject(prev => typeof transform === 'function' ? transform(prev) : transform);
  }

  function addCallNode(contractId: string, signature: string, anchor: Vec2) {
    const id = createId(project.nodes.map(n => n.id), 'call');
    setFocusNodeId(id);
    editVisual(p => {
      // The same normalization rule as existing-node drags (resolveNodeDrop):
      // the card's rect at the drop point picks the branch (header/divider/
      // outside stay top-level), then the full rect is placed inside the
      // branch body — a free slot if one exists, else the clamped point.
      const call: GraphNode = { id, kind: 'call', contractId, signature };
      const size = nodeSize(call, p);
      const resolved = resolveNodeDrop({ project: p, node: call, desiredPosition: anchor });
      if (resolved.scope !== null) {
        const placed = spawnInsideIf({ project: p, frameId: resolved.scope.parent, branch: resolved.scope.branch, size, anchor });
        const node = { ...call, ...resolved.scope } as GraphNode;
        return addNode(p, node, placed ? placed.position : resolved.position);
      }
      return addNode(p, call, spawnNear(p, { x: anchor.x + size.width / 2, y: anchor.y + size.height / 2 }, call));
    });
  }

  function moveNodes(changes: Readonly<Record<string, Vec2>>, scopes: Readonly<Record<string, ScopeTarget | null>> = {}) {
    const semantic = Object.keys(scopes).length > 0;
    editVisual(p => moveGraphNodes(p, changes, scopes), !semantic);
  }

  function addVisualNode(partial: GraphNodeDraft, prefix: string) {
    const id = createId(project.nodes.map(n => n.id), prefix);
    setFocusNodeId(id);
    editVisual(p => placeNode(p, { ...partial, id } as GraphNode));
  }

  /**
   * One creation funnel for palette adds and click-to-adds. The selected
   * branch region claims the new node when one was clicked; otherwise a
   * selected IF claims it into THEN. The node spawns in a free slot of that
   * branch body (growing the frame when needed) and takes the semantic
   * parent/branch explicitly — never inferred from screen overlap. Without
   * an IF context the viewport spiral decides.
   */
  function placeNode(p: VisualProject, node: GraphNode): VisualProject {
    const scope: ScopeTarget | null = selectedBranch !== null
      && p.nodes.some(n => n.id === selectedBranch.nodeId && n.kind === 'if'
          && (selectedBranch.branch === 'then' || n.hasElse === true))
      ? { parent: selectedBranch.nodeId, branch: selectedBranch.branch }
      : selectedId !== null && p.nodes.some(n => n.id === selectedId && n.kind === 'if')
        ? { parent: selectedId, branch: 'then' }
        : null;
    if (scope !== null && scope.parent !== node.id) {
      const placed = spawnInsideIf({ project: p, frameId: scope.parent, branch: scope.branch, size: nodeSize(node, p) });
      if (placed) return addNode(p, { ...node, parent: scope.parent, branch: scope.branch } as GraphNode, placed.position);
    }
    return addNode(p, node, spawnNear(p, viewportCenter(), node));
  }

  /** Viewport-aware placement for nodes with no IF context: visible spiral. */
  function spawnNear(p: VisualProject, anchor: Vec2, node: GraphNode): Vec2 {
    return spawnPosition({
      anchor,
      size: nodeSize(node, p),
      occupied: occupiedRects(p),
      bounds: canvasApi.current?.viewportRect() ?? null,
    });
  }

  function viewportCenter(): Vec2 {
    return canvasApi.current?.viewportCenter() ?? { x: 320, y: 240 };
  }

  /** Click-to-add from the library: into the selected IF, else the viewport. */
  function addFunctionNode(contractId: string, signature: string) {
    const id = createId(project.nodes.map(n => n.id), 'call');
    setFocusNodeId(id);
    editVisual(p => placeNode(p, { id, kind: 'call', contractId, signature }));
  }

  /** Restore the deleted graph; any compiled output was already invalidated. */
  function undoDelete() {
    const snapshot = undo?.snapshot;
    setUndo(null);
    if (snapshot) editVisual(snapshot);
  }

  function deleteNodes(ids: string[]) {
    if (selectedId && ids.includes(selectedId)) setSelectedId(null);
    if (selectedBranch && ids.includes(selectedBranch.nodeId)) setSelectedBranch(null);
    const edgesLost = project.edges.filter(e => ids.includes(e.from.node) || ids.includes(e.to.node)).length;
    const message = `Removed ${ids.length} node${ids.length === 1 ? '' : 's'}${edgesLost > 0 ? ` and ${edgesLost} edge${edgesLost === 1 ? '' : 's'}` : ''}`;
    keepUndoSlot.current = true;
    editVisual(p => removeNodes(p, ids));
    setUndo({ snapshot: project, message });
  }

  function deleteEdges(ids: string[]) {
    if (selectedEdgeId && ids.includes(selectedEdgeId)) setSelectedEdgeId(null);
    keepUndoSlot.current = true;
    editVisual(p => ids.reduce(removeEdge, p));
    setUndo({ snapshot: project, message: `Removed ${ids.length} edge${ids.length === 1 ? '' : 's'}` });
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

  /** Compact state shown on the collapsed output bar. */
  function outputSummary() {
    if (error) return <><WarningRoundedIcon fontSize="small" sx={{ color: 'error.main', fontSize: 18 }} />
      <Typography variant="caption" color="text.secondary">failed</Typography></>;
    if (busy) return <><CircularProgress size={12} />
      <Typography variant="caption" color="text.secondary">compiling…</Typography></>;
    if (output) return <><CheckCircleOutlineRoundedIcon fontSize="small" sx={{ color: 'success.main', fontSize: 18 }} />
      <Typography variant="caption" color="text.secondary">compiled · {output.byteSize} bytes</Typography></>;
    return <Typography variant="caption" color="text.secondary">idle</Typography>;
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
        setNotice(`Imported ${file.name} · ${artifact.compiler.name} ${artifact.compiler.version} · inspection only`);
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

  function copy() {
    if (!output) return;
    void navigator.clipboard.writeText(output.program)
      .then(() => setNotice('Bytecode copied'))
      .catch(() => setNotice('Clipboard unavailable in this browser'));
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

  const outputPanel = <OutputPanel
    output={output}
    error={error}
    notice={notice}
    busy={busy}
    imported={importedArtifact !== null}
    generated={generated}
    actions={<ExecuteBlocks execution={execution} />}
    onCopy={copy}
    onDownload={download}
    onErrorReveal={line => editorRef.current?.revealLine(line)}
  />;

  return <ThemeProvider theme={theme}>
    <CssBaseline />
    <GlobalStyles styles={cssVarStyles} />
    <Box className={mode === 'visual' ? 'app app-fixed' : 'app'}>
      <Stack component="header" className="topbar" direction="row" alignItems="center" justifyContent="space-between" gap={2}>
        <Stack direction="row" alignItems="center" spacing={1.5}>
          <Box className="brand-mark" aria-hidden="true"><BoltRoundedIcon fontSize="small" /></Box>
          <Box>
            <Typography variant="h5" fontWeight={700}>LISA IDE</Typography>
            <Typography variant="body2" color="text.secondary">Write, compile, and inspect LISA programs</Typography>
          </Box>
        </Stack>
        <WalletExecutionPanel execution={execution} />
      </Stack>
      <Toolbar
        mode={mode}
        busy={busy}
        onModeChange={next => { invalidateOutput(); setMode(next); }}
        onCompile={compile}
        onImportFile={file => void importArtifact(file)}
      />
      {mode === 'code' ? <Box className="workspace">
        <Paper className="pane source-pane" elevation={0}>
          <Stack className="pane-heading" direction="row" justifyContent="space-between" alignItems="center" gap={1}>
            <PaneTitle icon={<DescriptionRoundedIcon />}>Source</PaneTitle>
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
              <Typography variant="caption" component="span" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                Compile with <kbd>Ctrl/⌘ + Enter</kbd>
              </Typography>
            </Stack>
          </Stack>
          <SourceEditor
            ref={editorRef}
            value={source}
            onChange={next => replaceSource(next)}
            onCompile={compile}
            diagnostic={error}
          />
        </Paper>
        <Paper className="pane output-pane" elevation={0}>
          <Stack className="pane-heading" direction="row" alignItems="center" justifyContent="space-between" gap={1}>
            <PaneTitle icon={<TerminalRoundedIcon />}>Output</PaneTitle>
            {executeSlot}
          </Stack>
          <Box className="output-content">{outputPanel}</Box>
        </Paper>
      </Box> : <Box className={`visual-workspace${libraryOpen ? '' : ' library-collapsed'}`}>
        <Paper className="pane canvas-pane" elevation={0}>
          <Box className="pane-heading"><PaneTitle icon={<DashboardRoundedIcon />}>Canvas</PaneTitle></Box>
          <VisualCanvas
            canvasApi={canvasApi}
            project={project}
            onMoveNodes={moveNodes}
            onAddCallNode={addCallNode}
            onDeleteNodes={deleteNodes}
            onDeleteEdges={deleteEdges}
            onConnect={(from, to) => editVisual(p => connectPort(p, { from, to }))}
            onPatchNode={(id, fields) => editVisual(p => updateNode(p, id, fields))}
            onResizeIf={(id, size) => editVisual(p => setNodeFrameSize(p, id, size), true)}
            onEnableElse={id => editVisual(p => enableElse(p, id))}
            onSelectBranch={(nodeId, branch) => { setSelectedBranch({ nodeId, branch }); setSelectedId(nodeId); }}
            selectedBranch={selectedBranch}
            onSelectNode={id => {
              setSelectedId(id);
              if (id !== null) setSelectedEdgeId(null);
              if (selectedBranch && selectedBranch.nodeId !== id) setSelectedBranch(null);
            }}
            onSelectEdge={id => { setSelectedEdgeId(id); if (id !== null) setSelectedId(null); }}
            selectedNodeId={selectedId}
            selectedEdgeId={selectedEdgeId}
            diagnostics={diagnostics}
            focusNodeId={focusNodeId}
          />
        </Paper>
        <Paper className="pane side-pane" elevation={0}>
          <Stack className="pane-heading" direction="row" alignItems="center" justifyContent="space-between" gap={1}>
            {libraryOpen && <PaneTitle icon={<LibraryBooksRoundedIcon />}>Library</PaneTitle>}
            <IconButton size="small" aria-label={libraryOpen ? 'Collapse library' : 'Expand library'}
              onClick={() => setLibraryOpen(open => !open)} sx={{ p: 0.5 }}>
              {libraryOpen
                ? <ChevronRightRoundedIcon fontSize="small" />
                : <ChevronLeftRoundedIcon fontSize="small" />}
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
                  />
                </Box>
              </Box>
            </Box>
          </>}
        </Paper>
        <Paper className={`pane output-pane${outputOpen ? '' : ' output-collapsed'}`} elevation={0}>
          <Stack className="pane-heading" direction="row" alignItems="center" justifyContent="space-between" gap={1}>
            <Button size="small" onClick={() => setOutputOpen(open => !open)} aria-expanded={outputOpen}
              startIcon={outputOpen
                ? <ExpandMoreRoundedIcon fontSize="small" />
                : <ChevronRightRoundedIcon fontSize="small" />}
              sx={{ justifyContent: 'flex-start', minWidth: 0, px: 0.5 }}>
              Output
            </Button>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              {!outputOpen && outputSummary()}
              {executeSlot}
            </Box>
          </Stack>
          {/* Collapsed, this bar is the program's whole visible surface — so a
              dismissed transaction's receipt lives here too, until it is empty. */}
          {!outputOpen && <Box sx={{ px: 1.5, pb: 1 }}><ExecuteBlocks execution={execution} /></Box>}
          {outputOpen && <Box className="output-content">{outputPanel}</Box>}
        </Paper>
      </Box>}
      <ExecutionDialog execution={execution} />
      <Snackbar
        open={undo !== null}
        autoHideDuration={7000}
        onClose={() => setUndo(null)}
        message={undo?.message ?? ''}
        action={<Button size="small" color="inherit" onClick={undoDelete}>Undo</Button>}
      />
    </Box>
  </ThemeProvider>;
}
