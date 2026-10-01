import { Background, Controls, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

export function VisualCanvas() {
  return <div className="canvas-host" aria-label="Visual canvas">
    <ReactFlow
      nodes={[]}
      edges={[]}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#26354c" gap={24} />
      <Controls showInteractive={false} />
    </ReactFlow>
  </div>;
}
