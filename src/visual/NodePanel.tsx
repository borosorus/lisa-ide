import { Box, Button, Stack, Typography } from '@mui/material';
import { DEFAULT_HASH_DATA, DEFAULT_RAW_CALLDATA, type GraphNode, type GraphNodeDraft, type VisualProject } from './model';
import { findFunction } from './ports';
import { tokens } from '../theme/tokens';

/** Sidebar: create nodes; the selected node gets compact read-only details. */

const PORT_LEGEND: ReadonlyArray<{ readonly color: string; readonly label: string }> = [
  { color: tokens.port.value, label: 'value' },
  { color: tokens.port.address, label: 'address' },
  { color: tokens.port.bool, label: 'bool' },
  { color: tokens.port.condition, label: 'condition' },
];

export function VisualPalette({ onAdd }: {
  onAdd: (node: GraphNodeDraft, prefix: string) => void;
}) {
  return <Box>
    <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Values / Logic</Typography>
    <Stack direction="row" flexWrap="wrap" gap={0.5}>
      <Button size="small" variant="outlined" onClick={() => onAdd({ kind: 'context', name: 'SELF' }, 'ctx')}>Context</Button>
      <Button size="small" variant="outlined" onClick={() => onAdd({ kind: 'literal', literalType: 'uint', literal: '0' }, 'lit')}>Literal</Button>
      <Button size="small" variant="outlined" onClick={() => onAdd({ kind: 'binary', op: 'add' }, 'op')}>Operation</Button>
      <Button size="small" variant="outlined" title="Read the balance of an address (BALANCE)"
        onClick={() => onAdd({ kind: 'balance' }, 'bal')}>Balance</Button>
      <Button size="small" variant="outlined" title="Hash constant byte data (KECCAK256)"
        onClick={() => onAdd({ kind: 'keccak', data: DEFAULT_HASH_DATA }, 'hash')}>Hash</Button>
      <Button size="small" variant="outlined" title="Revert unless a condition holds (REVERT)"
        onClick={() => onAdd({ kind: 'guard' }, 'guard')}>Guard</Button>
      <Button size="small" variant="outlined" onClick={() => onAdd({ kind: 'if' }, 'if')}>IF</Button>
    </Stack>
    <Typography variant="subtitle2" sx={{ mb: 0.5, mt: 1 }}>Transfers / Raw calls</Typography>
    <Stack direction="row" flexWrap="wrap" gap={0.5}>
      <Button size="small" variant="outlined" title="Send value to any address from the account running this program (CALL with value)"
        onClick={() => onAdd({ kind: 'send' }, 'send')}>Send</Button>
      <Button size="small" variant="outlined" title="Call any address with calldata encoded elsewhere; value is optional (raw calldata CALL)"
        onClick={() => onAdd({ kind: 'rawcall', calldata: DEFAULT_RAW_CALLDATA }, 'raw')}>Raw call</Button>
    </Stack>
    {/* Port fills carry type; the meaning is otherwise never taught. */}
    <Box className="port-legend" aria-label="Port type colors">
      {PORT_LEGEND.map(port => <span key={port.label} className="port-legend-item">
        <i className="legend-dot" style={{ background: port.color }} aria-hidden="true" />
        {port.label}
      </span>)}
    </Box>
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
    {node.kind === 'balance' && <Typography variant="body2" color="text.secondary">
      Reads the balance of the address it receives. Nothing is stored — every use reads it again.
    </Typography>}
    {node.kind === 'keccak' && <Typography variant="body2" color="text.secondary">
      Keccak-256 of {node.data === '0x' ? 'no data' : node.data}, computed once wherever it is used.
    </Typography>}
    {node.kind === 'send' && <Typography variant="body2" color="text.secondary">
      Sends value, in wei, from the account running this program to the address it receives. Both inputs are required.
    </Typography>}
    {node.kind === 'rawcall' && <Typography variant="body2" color="text.secondary">
      Calls the address it receives with exactly {node.calldata === '0x' ? 'no calldata' : node.calldata};
      an unwired value means nothing is sent with the call.
    </Typography>}
    {node.kind === 'guard' && <Typography variant="body2" color="text.secondary">
      Reverts the program when its condition is false, carrying no revert data.
    </Typography>}
    {node.kind === 'if' && <Typography variant="body2" color="text.secondary">
      Nodes dragged into its frame run inside it.
    </Typography>}
    {node.parent !== undefined && <Typography variant="body2" color="text.secondary">
      Inside {node.parent} — drag it out of the frame to remove the scope.
    </Typography>}
  </Stack>;
}
