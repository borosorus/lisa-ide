import { Box, Button, Stack, Typography } from '@mui/material';
import type { GraphNode, GraphNodeDraft, VisualProject } from './model';
import { findFunction } from './ports';

/** Sidebar: create nodes; the selected node gets compact read-only details. */

export function VisualPalette({ onAdd }: {
  onAdd: (node: GraphNodeDraft, prefix: string) => void;
}) {
  return <Box>
    <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Values / Logic</Typography>
    <Stack direction="row" flexWrap="wrap" gap={0.5}>
      <Button size="small" variant="outlined" onClick={() => onAdd({ kind: 'context', name: 'SELF' }, 'ctx')}>Context</Button>
      <Button size="small" variant="outlined" onClick={() => onAdd({ kind: 'literal', literalType: 'uint', literal: '0' }, 'lit')}>Literal</Button>
      <Button size="small" variant="outlined" onClick={() => onAdd({ kind: 'binary', op: 'add' }, 'op')}>Operation</Button>
      <Button size="small" variant="outlined" onClick={() => onAdd({ kind: 'if' }, 'if')}>IF</Button>
    </Stack>
  </Box>;
}

/*
 * Everything editable — literals, context values, operations, IF scope — is
 * edited directly on the node card; a selector here would duplicate it (and
 * drift from what the canvas shows). This panel stays read-only detail.
 */
export function NodeInspector({ node, project }: {
  node: GraphNode | null;
  project: VisualProject;
}) {
  if (!node) {
    return <Typography variant="body2" color="text.secondary">Select a node to inspect it, or drag a contract function onto the canvas. Values are edited on the nodes themselves.</Typography>;
  }
  return <Stack spacing={0.5}>
    <Typography variant="subtitle2">{node.kind} · {node.id}</Typography>
    {node.kind === 'call' && (() => {
      const contract = project.contracts.find(c => c.id === node.contractId);
      const fn = findFunction(project, node.contractId, node.signature);
      return <Typography variant="body2" color="text.secondary">
        {contract?.name ?? 'unknown contract'} · {fn?.signature ?? node.signature}
        {' · follows the contract address automatically'}
      </Typography>;
    })()}
    {node.kind === 'context' && <Typography variant="body2" color="text.secondary">Reads {node.name}.</Typography>}
    {node.kind === 'literal' && <Typography variant="body2" color="text.secondary">{node.literalType} = {node.literal}.</Typography>}
    {node.kind === 'binary' && <Typography variant="body2" color="text.secondary">Arithmetic on its inputs ({node.op}).</Typography>}
    {node.kind === 'if' && <Typography variant="body2" color="text.secondary">
      Nodes dragged into its frame run inside it.
    </Typography>}
    {node.parent !== undefined && <Typography variant="body2" color="text.secondary">
      Inside {node.parent} — drag it out of the frame to remove the scope.
    </Typography>}
  </Stack>;
}
