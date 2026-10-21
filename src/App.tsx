import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box, Button, CircularProgress, CssBaseline, GlobalStyles, IconButton, Paper,
  Snackbar, Stack, ThemeProvider, Tooltip, Typography,
} from '@mui/material';
import BoltRoundedIcon from '@mui/icons-material/BoltRounded';

import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import DescriptionRoundedIcon from '@mui/icons-material/DescriptionRounded';
import DashboardRoundedIcon from '@mui/icons-material/DashboardRounded';
import LibraryBooksRoundedIcon from '@mui/icons-material/LibraryBooksRounded';
import AutoFixHighRoundedIcon from '@mui/icons-material/AutoFixHighRounded';
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded';
import WarningRoundedIcon from '@mui/icons-material/WarningRounded';
import { SourceEditor, type SourceEditorHandle } from './editor/SourceEditor';
import { SOURCE_EXAMPLES, STARTER_SOURCE } from './editor/examples';
import { VISUAL_EXAMPLES, type VisualExample } from './visual/examples';
import { CompilerClient, CompilerError } from './compile/client';
import { createArtifact, parseArtifact, type ProgramArtifact } from './compile/artifact';
import type { CompileDiagnostic, CompileOutput } from './compile/types';
import { ContractsPanel } from './visual/ContractsPanel';
import { GraphError, generateVisualSource } from './visual/generate';
import { VisualCanvas, type CanvasApi } from './visual/VisualCanvas';
import {
  addContract, addNode, connectPort, duplicateNode, moveGraphNodes, removeContract, removeEdge, removeNodes, resetCanvas, setCallFailureMode,
  setExecutionAfter, setNodeFrameSize, updateContract, updateNode,
} from './visual/projectState';
import { createId, emptyProject, type GraphNode, type GraphNodeDraft, type ScopeTarget, type Vec2, type VisualProject } from './visual/model';
import { isContainer } from './visual/controlFlow';
import { NodeMenu } from './visual/NodePanel';
import { nodeSize, spawnPosition } from './visual/spawnPosition';
import { effectiveSize, occupiedRects, resolveNodeDrop, spawnInsideIf } from './visual/containment';
import { validateProject } from './visual/validate';
import { loadStoredProject, saveStoredProject, type AuthoringMode } from './visual/storage';
import { WalletExecutionPanel } from './wallet/WalletExecutionPanel';
import { ExecuteBlocks, ExecuteButton } from './wallet/ExecuteActions';
import { ExecutionDialog } from './wallet/ExecutionDialog';
import { useWalletExecution } from './wallet/useWalletExecution';
import { Toolbar } from './shell/Toolbar';
import { OutputPanel } from './shell/OutputPanel';
import { ExampleSelect } from './shell/ExampleSelect';
import { cssVarStyles, theme } from './theme/theme';
import './styles.css';

function diagnosticFrom(error: unknown): CompileDiagnostic {
  if (error instanceof CompilerError) return error.diagnostic;
  return { message: error instanceof Error ? error.message : String(error) };
}

const DEFAULT_STORED = { version: 3 as const, mode: 'code' as AuthoringMode, codeSource: null, visual: emptyProject() };

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
  // New or menu-selected nodes are revealed; the token permits repeat selects.
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [visualCanvasKey, setVisualCanvasKey] = useState(0);
  const [fitViewRequest, setFitViewRequest] = useState(0);
  const [libraryOpen, setLibraryOpen] = useState(true);
  // One-deep, single-slot undo for graph deletions: a hand-built graph can lose
  // minutes of wiring to one Delete keypress, and that keystroke is silent.
  const [undo, setUndo] = useState<{ snapshot: VisualProject; message: string; refitOnUndo?: boolean; positional?: boolean } | null>(null);
  // Lets a deletion's own editVisual pass through without voiding the slot it just filled.
  const keepUndoSlot = useRef(false);
  // Output is a shared bottom dock. It opens when the user compiles or imports.
  const [outputOpen, setOutputOpen] = useState(false);
  // Errors are otherwise invisible behind a collapsed panel; open to reveal.
  useEffect(() => { if (error) setOutputOpen(true); }, [error]);
  const client = useRef<CompilerClient | null>(null);
  const canvasApi = useRef<CanvasApi | null>(null);
  const editorRef = useRef<SourceEditorHandle | null>(null);
  const revision = useRef(0);

  function requestNodeFocus(id: string | null) {
    setFocusNodeId(id);
    if (id !== null) setFocusRequest(request => request + 1);
  }

  useEffect(() => () => client.current?.dispose(), []);
  useEffect(() => saveStoredProject({ version: 3, mode, codeSource: source, visual: project }), [mode, source, project]);
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
  // Mounted once in the shared Output dock header.
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

  function loadVisualExample(example: VisualExample) {
    setSelectedId(null);
    setSelectedEdgeId(null);
    requestNodeFocus(null);
    keepUndoSlot.current = false;
    editVisual(example.createProject());
    setVisualCanvasKey(key => key + 1);
    setNotice(`Loaded visual example: ${example.label}`);
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
    requestNodeFocus(id);
    editVisual(p => {
      // The same normalization rule as existing-node drags (resolveNodeDrop):
      // the card's rect at the drop point picks a container, then the full
      // rect is placed inside that body — a free slot if one exists.
      const call: GraphNode = { id, kind: 'call', contractId, signature };
      const size = nodeSize(call, p);
      const resolved = resolveNodeDrop({ project: p, node: call, desiredPosition: anchor });
      if (resolved.scope !== null) {
        const placed = spawnInsideIf({ project: p, frameId: resolved.scope.parent, branch: 'then', size, anchor });
        const node = { ...call, parent: resolved.scope.parent } as GraphNode;
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
    requestNodeFocus(id);
    selectCreatedNode(id);
    editVisual(p => placeNode(p, { ...partial, id } as GraphNode));
  }

  function selectCreatedNode(id: string) {
    setSelectedId(id);
    setSelectedEdgeId(null);
  }

  /**
   * One creation funnel for palette adds and click-to-adds. A selected
   * container claims new nodes into its body. The standalone ELSE action
   * stays a sibling of a selected IF so it can be connected to that IF.
   */
  function placeNode(p: VisualProject, node: GraphNode): VisualProject {
    const selected = p.nodes.find(candidate => candidate.id === selectedId);
    if (node.kind === 'else' && selected?.kind === 'if') {
      const origin = p.positions[selected.id] ?? viewportCenter();
      const anchor = { x: origin.x + nodeSize(selected, p).width + 56, y: origin.y };
      if (selected.parent) {
        const placed = spawnInsideIf({ project: p, frameId: selected.parent, branch: 'then', size: nodeSize(node, p), anchor });
        if (placed) return addNode(p, { ...node, parent: selected.parent }, placed.position);
      }
      return addNode(p, node, spawnNear(p, anchor, node));
    }
    const scope: ScopeTarget | null = selected && isContainer(selected) ? { parent: selected.id, branch: 'then' } : null;
    if (scope !== null && scope.parent !== node.id) {
      const placed = spawnInsideIf({ project: p, frameId: scope.parent, branch: 'then', size: nodeSize(node, p) });
      if (placed) return addNode(p, { ...node, parent: scope.parent } as GraphNode, placed.position);
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
    requestNodeFocus(id);
    selectCreatedNode(id);
    editVisual(p => placeNode(p, { id, kind: 'call', contractId, signature }));
  }

  function duplicateSelectedNode() {
    const source = project.nodes.find(node => node.id === selectedId);
    if (!source) return;
    const sourcePosition = project.positions[source.id] ?? viewportCenter();
    const size = effectiveSize(project, source);
    const anchor = {
      x: sourcePosition.x + size.width + 32 + size.width / 2,
      y: sourcePosition.y + size.height / 2,
    };
    let position: Vec2;
    if (source.parent !== undefined) {
      const placement = spawnInsideIf({
        project,
        frameId: source.parent,
        branch: 'then',
        size,
        anchor,
      });
      if (!placement) {
        setNotice('Could not find room to duplicate this node inside its container.');
        return;
      }
      position = placement.position;
    } else {
      position = spawnPosition({
        anchor,
        size,
        occupied: occupiedRects(project),
        bounds: canvasApi.current?.viewportRect() ?? null,
      });
    }
    const duplicated = duplicateNode(project, source.id, position);
    if (!duplicated) return;
    editVisual(duplicated.project);
    setSelectedId(duplicated.nodeId);
    setSelectedEdgeId(null);
    requestNodeFocus(source.parent === undefined ? duplicated.nodeId : null);
    setUndo({ snapshot: project, message: duplicated.externalTryResultsOmitted
      ? 'IF duplicated; try-call results need rewiring' : 'Node duplicated' });
    setNotice(duplicated.externalTryResultsOmitted
      ? 'Duplicated the IF/ELSE pair. Wire its try-call result inputs to a try-call inside the copied block.'
      : source.kind === 'if' ? 'Duplicated the IF/ELSE pair and its nested contents.' : 'Duplicated the selected node.');
  }

  function resetVisualCanvas() {
    if (project.nodes.length === 0) return;
    const snapshot = project;
    editVisual(resetCanvas(project));
    setSelectedId(null);
    setSelectedEdgeId(null);
    requestNodeFocus(null);
    setVisualCanvasKey(key => key + 1);
    setUndo({ snapshot, message: 'Canvas reset', refitOnUndo: true });
    setNotice('Canvas reset. Contract resources remain available.');
  }

  function arrangeNodes() {
    const result = canvasApi.current?.arrange();
    if (!result) return;
    if (result.error) {
      setNotice(result.error);
      return;
    }
    if (!result.changed) {
      setNotice(result.warning ?? 'Canvas is already arranged.');
      return;
    }
    editVisual(result.project, true);
    setUndo({ snapshot: project, message: 'Nodes arranged', positional: true });
    setFitViewRequest(request => request + 1);
    setNotice(result.warning ?? 'Nodes arranged by dependency.');
  }

  function changeCallFailureMode(callId: string, mode: 'revert' | 'continue'): string | undefined {
    const call = project.nodes.find(node => node.id === callId);
    if (!call || !['call', 'rawcall', 'send'].includes(call.kind)) return;
    const scaffold = { id: createId(project.nodes.map(node => node.id), 'if'), position: { x: 0, y: 0 } };
    if (mode === 'continue') {
      const gate: GraphNode = { id: scaffold.id, kind: 'if' };
      const size = nodeSize(gate, project);
      const sourcePosition = project.positions[callId] ?? viewportCenter();
      const sourceSize = nodeSize(call, project);
      const anchor = { x: sourcePosition.x + sourceSize.width + 28 + size.width / 2, y: sourcePosition.y + size.height / 2 };
      const placement = call.parent
        ? spawnInsideIf({ project, frameId: call.parent, branch: 'then', size, anchor })
        : null;
      scaffold.position = placement?.position ?? spawnNear(project, anchor, gate);
    }
    const transition = setCallFailureMode(project, callId, mode, mode === 'continue' ? scaffold : undefined);
    if (transition.message) return transition.message;
    if (transition.project !== project) editVisual(transition.project);
    if (transition.successIfId) {
      setSelectedId(transition.successIfId);
      // A nested scaffold is created beside a call already in the viewport.
      // Fitting only that child makes xyflow mis-center nested coordinates;
      // keep the current view for nested calls and pan for top-level ones.
      requestNodeFocus(call.parent ? null : transition.successIfId);
    } else if (mode === 'revert') {
      const removedGate = project.nodes.find(node => node.kind === 'if' && node.autoSuccessFor === callId);
      if (removedGate && selectedId === removedGate.id) setSelectedId(null);
    }
    return undefined;
  }

  /** Restore the last graph action; presentation undo keeps compiled output. */
  function undoLastAction() {
    const entry = undo;
    setUndo(null);
    if (!entry) return;
    editVisual(entry.snapshot, entry.positional === true);
    if (entry.positional) {
      setFitViewRequest(request => request + 1);
    } else {
      setSelectedId(null);
      setSelectedEdgeId(null);
      requestNodeFocus(null);
    }
    if (entry.refitOnUndo) setVisualCanvasKey(key => key + 1);
  }

  function deleteNodes(ids: string[]) {
    if (selectedId && ids.includes(selectedId)) setSelectedId(null);
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
    setOutputOpen(true);
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
    setOutputOpen(true);
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

  function insertContractFunction(contract: VisualProject['contracts'][number], fn: VisualProject['contracts'][number]['functions'][number]) {
    const args = fn.inputs.map((type, index) => {
      // ABI parameter names are untrusted metadata. Keep them out of source
      // comments unless comment delimiters and line breaks are neutralized.
      const name = fn.inputNames?.[index]?.replace(/[*/\r\n\u2028\u2029]/g, ' ').trim();
      const hint = name ? `/* ${name} */ ` : '';
      if (type === 'address') return `${hint}CALLER`;
      if (type === 'bool') return `${hint}true`;
      return `${hint}0n`;
    });
    const encoded = `encodeCall(${JSON.stringify(fn.signature)}${args.length ? `, [${args.join(', ')}]` : ''})`;
    const method = fn.mutability === 'view' || fn.mutability === 'pure' ? 'staticCall' : 'call';
    editorRef.current?.insertSnippet(`p.${method}(${JSON.stringify(contract.address)}, ${encoded});`);
  }

  return <ThemeProvider theme={theme}>
    <CssBaseline />
    <GlobalStyles styles={cssVarStyles} />
    <Box className="app app-fixed">
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
      <Box className={`workspace${libraryOpen ? '' : ' library-collapsed'}`}>
        {mode === 'code' ? <Paper className="pane source-pane" elevation={0}>
          <Stack className="pane-heading" direction="row" justifyContent="space-between" alignItems="center" gap={1}>
            <PaneTitle icon={<DescriptionRoundedIcon />}>Source</PaneTitle>
            <ExampleSelect
              options={SOURCE_EXAMPLES}
              ariaLabel="Load example"
              minWidth={170}
              onSelect={example => replaceSource(example.source, `Loaded example: ${example.label}`)}
            />
          </Stack>
          <SourceEditor
            ref={editorRef}
            value={source}
            onChange={next => replaceSource(next)}
            onCompile={compile}
            diagnostic={error}
          />
        </Paper> : <Paper className="pane canvas-pane" elevation={0}>
          <Stack className="pane-heading" direction="row" justifyContent="space-between" alignItems="center" gap={1}>
            <PaneTitle icon={<DashboardRoundedIcon />}>Canvas</PaneTitle>
            <Stack direction="row" alignItems="center" gap={0.75}>
              <NodeMenu
                project={project}
                onAdd={addVisualNode}
              />
              <Tooltip title="Arrange nodes by dependency without changing the program">
                <span>
                  <Button size="small" variant="outlined" startIcon={<AutoFixHighRoundedIcon fontSize="small" />}
                    disabled={project.nodes.length === 0} onClick={arrangeNodes}>
                    Arrange
                  </Button>
                </span>
              </Tooltip>
              <ExampleSelect
                options={VISUAL_EXAMPLES}
                ariaLabel="Load visual example"
                minWidth={160}
                maxWidth="38%"
                onSelect={loadVisualExample}
              />
              <Tooltip title="Reset canvas — clear nodes and wiring, keep contracts">
                <span>
                  <IconButton size="small" color="warning" aria-label="Reset canvas" title="Reset canvas"
                    disabled={project.nodes.length === 0}
                    onClick={resetVisualCanvas}>
                    <RestartAltRoundedIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>
          </Stack>
          <VisualCanvas
            key={visualCanvasKey}
            canvasApi={canvasApi}
            fitViewRequest={fitViewRequest}
            project={project}
            onMoveNodes={moveNodes}
            onAddCallNode={addCallNode}
            onDeleteNodes={deleteNodes}
            onDeleteEdges={deleteEdges}
            onConnect={(from, to) => editVisual(p => connectPort(p, { from, to }))}
            onPatchNode={(id, fields) => editVisual(p => updateNode(p, id, fields))}
            onSetFailureMode={changeCallFailureMode}
            onResizeIf={(id, size) => editVisual(p => setNodeFrameSize(p, id, size), true)}
            onSelectNode={id => {
              setSelectedId(id);
              if (id !== null) setSelectedEdgeId(null);
            }}
            onDuplicateSelected={duplicateSelectedNode}
            onSetExecutionAfter={(id, predecessorId) => editVisual(p => setExecutionAfter(p, id, predecessorId))}
            onSelectEdge={id => {
              setSelectedEdgeId(id);
              if (id !== null) {
                setSelectedId(null);
              }
            }}
            selectedNodeId={selectedId}
            selectedEdgeId={selectedEdgeId}
            diagnostics={diagnostics}
            focusNodeId={focusNodeId}
            focusRequest={focusRequest}
          />
        </Paper>}
        <Paper className={`pane side-pane${libraryOpen ? '' : ' side-pane-collapsed'}`} elevation={0}>
          <Stack className={`pane-heading library-heading${libraryOpen ? '' : ' library-heading-collapsed'}`} direction="row" alignItems="center" justifyContent="space-between" gap={1}>
            {libraryOpen ? <>
              <PaneTitle icon={<LibraryBooksRoundedIcon />}>Library</PaneTitle>
              <Tooltip title="Collapse library">
                <IconButton size="small" aria-label="Collapse library" aria-expanded={libraryOpen}
                  onClick={() => setLibraryOpen(false)} sx={{ p: 0.5 }}>
                  <ChevronRightRoundedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </> : <Tooltip title="Expand library">
              <Button size="small" aria-label="Expand library" aria-expanded={libraryOpen}
                startIcon={<LibraryBooksRoundedIcon />} onClick={() => setLibraryOpen(true)}>
                Library
              </Button>
            </Tooltip>}
          </Stack>
          <Box className="side-content" hidden={!libraryOpen}>
            <ContractsPanel
              mode={mode}
              contracts={project.contracts}
              onAddContract={contract => editVisual(p => addContract(p, contract))}
              onUpdateContract={(id, patch) => editVisual(p => updateContract(p, id, patch))}
              onRemoveContract={id => editVisual(p => removeContract(p, id))}
              onAddFunction={addFunctionNode}
              onInsertFunction={insertContractFunction}
            />
          </Box>
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
          {/* Collapsed, this bar is the program's whole visible surface — keep
              pending and failure details available here after dismissal. */}
          {!outputOpen && <Box sx={{ px: 1.5, pb: 1 }}><ExecuteBlocks execution={execution} /></Box>}
          {outputOpen && <Box className="output-content">{outputPanel}</Box>}
        </Paper>
      </Box>
      <ExecutionDialog execution={execution} />
      <Snackbar
        open={undo !== null}
        autoHideDuration={7000}
        onClose={() => setUndo(null)}
        message={undo?.message ?? ''}
        action={<Button size="small" color="inherit" onClick={undoLastAction}>Undo</Button>}
      />
    </Box>
  </ThemeProvider>;
}
