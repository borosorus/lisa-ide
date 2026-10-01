import { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import {
  Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow,
  type Connection, type Edge, type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { LisaNode, NodeEditContext, portsForNode, type NodeEditApi } from './flowNodes';
import { canConnect } from './ports';
import type { Vec2, VisualProject } from './model';
import { FUNCTION_MIME } from './ContractsPanel';

const nodeTypes = { lisa: LisaNode };

/** Lets the sidebar place click-added nodes in the visible viewport. */
export interface CanvasApi {
  viewportCenter(): Vec2 | null;
  /** Flow-space rect of the currently visible canvas area. */
  viewportRect(): { x: number; y: number; width: number; height: number } | null;
}

export interface VisualCanvasProps {
  project: VisualProject;
  onMoveNodes(changes: Readonly<Record<string, Vec2>>): void;
  onAddCallNode(contractId: string, signature: string, position: Vec2): void;
  onDeleteNodes(ids: string[]): void;
  onDeleteEdges(ids: string[]): void;
  onConnect(from: { node: string; port: string }, to: { node: string; port: string }): void;
  /** Inline edit commit from a node card; semantics stay in the project layer. */
  onPatchNode(id: string, fields: Record<string, unknown>): void;
  onSelectNode(id: string | null): void;
  onSelectEdge(id: string | null): void;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  /** Last added node; the view pans to keep new nodes discoverable. */
  focusNodeId?: string | null;
  /** Host handle for click-to-add placement in the visible viewport. */
  canvasApi?: React.MutableRefObject<CanvasApi | null>;
}

/**
 * Controlled projection of the semantic project. React Flow state is derived
 * on every render; only drops, drags, connections, deletes, and inline edits
 * flow back out.
 */
export function VisualCanvas(props: VisualCanvasProps) {
  return <ReactFlowProvider>
    <Canvas {...props} />
  </ReactFlowProvider>;
}

function Canvas({
  project, onMoveNodes, onAddCallNode, onDeleteNodes, onDeleteEdges, onConnect, onPatchNode, onSelectNode, onSelectEdge, selectedNodeId, selectedEdgeId, focusNodeId, canvasApi,
}: VisualCanvasProps) {
  const { screenToFlowPosition, fitView } = useReactFlow();
  const hostRef = useRef<HTMLDivElement | null>(null);

  const ownApiRef = useRef<CanvasApi | null>(null);
  const apiRef = canvasApi ?? ownApiRef;
  useImperativeHandle(apiRef, () => ({
    viewportCenter: () => {
      const rect = hostRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return null;
      return screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    },
    viewportRect: () => {
      const rect = hostRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return null;
      const topLeft = screenToFlowPosition({ x: rect.left, y: rect.top });
      const bottomRight = screenToFlowPosition({ x: rect.right, y: rect.bottom });
      return { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y };
    },
  }), [screenToFlowPosition]);

  /*
   * The project is canonical and React Flow is a controlled projection, so
   * xyflow's internal selection-based delete (which needs onNodesChange to
   * round-trip changes) is disabled; deletion follows our own selection.
   * Focused form controls (inputs, selects) keep their keystrokes.
   */
  const deleteRef = useRef({ selectedNodeId, selectedEdgeId, onDeleteNodes, onDeleteEdges });
  deleteRef.current = { selectedNodeId, selectedEdgeId, onDeleteNodes, onDeleteEdges };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
          || target instanceof HTMLSelectElement || target.isContentEditable)) return;
      const selection = deleteRef.current;
      if (selection.selectedNodeId) {
        event.preventDefault();
        selection.onDeleteNodes([selection.selectedNodeId]);
      } else if (selection.selectedEdgeId) {
        event.preventDefault();
        selection.onDeleteEdges([selection.selectedEdgeId]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const nodes = useMemo<Node[]>(() => project.nodes.map(node => ({
    id: node.id,
    type: 'lisa',
    position: project.positions[node.id] ?? { x: 0, y: 0 },
    data: { node, project },
  })), [project]);

  const edges = useMemo<Edge[]>(() => project.edges.map(edge => ({
    id: edge.id,
    source: edge.from.node,
    sourceHandle: edge.from.port,
    target: edge.to.node,
    targetHandle: edge.to.port,
  })), [project.edges]);

  const editApi = useMemo<NodeEditApi>(() => ({ patch: onPatchNode }), [onPatchNode]);

  const nodesRef = useRef(project.nodes);
  nodesRef.current = project.nodes;
  useEffect(() => {
    if (focusNodeId && nodesRef.current.some(n => n.id === focusNodeId)) {
      void fitView({ nodes: [{ id: focusNodeId }], maxZoom: 1, duration: 250 });
    }
  }, [focusNodeId, fitView]);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const payload = event.dataTransfer.getData(FUNCTION_MIME);
    if (!payload) return;
    try {
      const { contractId, signature } = JSON.parse(payload) as { contractId: string; signature: string };
      onAddCallNode(contractId, signature, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    } catch {
      // Malformed drags are ignored; the sidebar is the only producer.
    }
  }, [screenToFlowPosition, onAddCallNode]);

  const isValidConnection = useCallback((connection: Edge | Connection) => {
    const source = project.nodes.find(n => n.id === connection.source);
    const target = project.nodes.find(n => n.id === connection.target);
    if (!source || !target || connection.source === connection.target) return false;
    const sourcePort = portsForNode(source, project).outputs.find(p => p.name === connection.sourceHandle);
    const targetPort = portsForNode(target, project).inputs.find(p => p.name === connection.targetHandle);
    return !!sourcePort && !!targetPort && canConnect(sourcePort, targetPort);
  }, [project]);

  return <div className="canvas-host" aria-label="Visual canvas" ref={hostRef}
    onDrop={onDrop} onDragOver={onDragOver}
  >
    <NodeEditContext.Provider value={editApi}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
        onNodeDragStop={(_, node, group) => onMoveNodes(Object.fromEntries(
          [...(group ?? []), node].map(moved => [moved.id, moved.position] as const),
        ))}
        onNodesDelete={deleted => onDeleteNodes(deleted.map(node => node.id))}
        onEdgesDelete={deleted => onDeleteEdges(deleted.map(edge => edge.id))}
        onConnect={c => {
          if (c.source && c.target) {
            onConnect(
              { node: c.source, port: c.sourceHandle ?? 'out' },
              { node: c.target, port: c.targetHandle ?? 'in' },
            );
          }
        }}
        isValidConnection={isValidConnection}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        onEdgeClick={(_, edge) => onSelectEdge(edge.id)}
        onPaneClick={() => { onSelectNode(null); onSelectEdge(null); }}
      >
        <Background color="#26354c" gap={24} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </NodeEditContext.Provider>
  </div>;
}
