import { useCallback, useMemo } from 'react';
import {
  Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { nodeLabel, LisaNode } from './flowNodes';
import type { Vec2, VisualProject } from './model';
import { FUNCTION_MIME } from './ContractsPanel';

const nodeTypes = { lisa: LisaNode };

export interface VisualCanvasProps {
  project: VisualProject;
  onMoveNodes(changes: Readonly<Record<string, Vec2>>): void;
  onAddCallNode(contractId: string, signature: string, position: Vec2): void;
  onDeleteNodes(ids: string[]): void;
}

/**
 * Controlled projection of the semantic project. React Flow state is derived
 * on every render; only drops, drags, and deletes flow back out.
 */
export function VisualCanvas(props: VisualCanvasProps) {
  return <ReactFlowProvider>
    <Canvas {...props} />
  </ReactFlowProvider>;
}

function Canvas({ project, onMoveNodes, onAddCallNode, onDeleteNodes }: VisualCanvasProps) {
  const { screenToFlowPosition } = useReactFlow();

  const nodes = useMemo<Node[]>(() => project.nodes.map(node => ({
    id: node.id,
    type: 'lisa',
    position: project.positions[node.id] ?? { x: 0, y: 0 },
    data: { kind: node.kind, label: nodeLabel(node, project) },
  })), [project]);

  const edges = useMemo<Edge[]>(() => project.edges.map(edge => ({
    id: edge.id,
    source: edge.from.node,
    sourceHandle: edge.from.port,
    target: edge.to.node,
    targetHandle: edge.to.port,
  })), [project.edges]);

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

  return <div className="canvas-host" aria-label="Visual canvas"
    onDrop={onDrop} onDragOver={onDragOver}
  >
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      deleteKeyCode={['Backspace', 'Delete']}
      proOptions={{ hideAttribution: true }}
      onNodeDragStop={(_, node) => onMoveNodes({ [node.id]: node.position })}
      onNodesDelete={ids => onDeleteNodes(ids.filter(id => typeof id === 'string'))}
    >
      <Background color="#26354c" gap={24} />
      <Controls showInteractive={false} />
    </ReactFlow>
  </div>;
}
