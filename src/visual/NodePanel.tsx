import { useState } from 'react';
import {
  Box, Button, Chip, IconButton, Popover, Stack, Typography,
} from '@mui/material';
import AccountTreeRoundedIcon from '@mui/icons-material/AccountTreeRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import HelpOutlineRoundedIcon from '@mui/icons-material/HelpOutlineRounded';
import { DEFAULT_HASH_DATA, DEFAULT_RAW_CALLDATA, type GraphNodeDraft, type VisualProject } from './model';
import { tokens } from '../theme/tokens';

/** A compact expandable menu for adding nodes to the canvas. */

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
    <Box className="node-action-grid">
      <Button className="node-action-button" size="small" variant="outlined" onClick={() => onAdd({ kind: 'context', name: 'SELF' }, 'ctx')}>Context</Button>
      <Button className="node-action-button" size="small" variant="outlined" onClick={() => onAdd({ kind: 'literal', literalType: 'uint', literal: '0' }, 'lit')}>Literal</Button>
      <Button className="node-action-button" size="small" variant="outlined" onClick={() => onAdd({ kind: 'binary', op: 'add' }, 'op')}>Operation</Button>
      <Button className="node-action-button" size="small" variant="outlined" title="Read the balance of an address (BALANCE)"
        onClick={() => onAdd({ kind: 'balance' }, 'bal')}>Balance</Button>
      <Button className="node-action-button" size="small" variant="outlined" title="Hash constant byte data (KECCAK256)"
        onClick={() => onAdd({ kind: 'keccak', data: DEFAULT_HASH_DATA }, 'hash')}>Hash</Button>
      <Button className="node-action-button" size="small" variant="outlined" title="Revert unless a condition holds (REVERT)"
        onClick={() => onAdd({ kind: 'guard' }, 'guard')}>Guard</Button>
      <Button className="node-action-button" size="small" variant="outlined" onClick={() => onAdd({ kind: 'if' }, 'if')}>IF</Button>
      <Button className="node-action-button" size="small" variant="outlined" title="Create a standalone ELSE container; connect it to an IF to include it in generated code"
        onClick={() => onAdd({ kind: 'else' }, 'else')}>ELSE</Button>
    </Box>
    <Typography variant="subtitle2" sx={{ mb: 0.5, mt: 1 }}>Transfers / Raw calls</Typography>
    <Box className="node-action-grid">
      <Button className="node-action-button" size="small" variant="outlined" title="Send value to any address from the account running this program (CALL with value)"
        onClick={() => onAdd({ kind: 'send' }, 'send')}>Send</Button>
      <Button className="node-action-button" size="small" variant="outlined" title="Call any address with calldata encoded elsewhere; value is optional (raw calldata CALL)"
        onClick={() => onAdd({ kind: 'rawcall', calldata: DEFAULT_RAW_CALLDATA }, 'raw')}>Raw call</Button>
    </Box>
  </Box>;
}

export function NodeMenu({ project, onAdd }: {
  project: VisualProject;
  onAdd: (node: GraphNodeDraft, prefix: string) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return <>
    <Button
      size="small"
      variant={anchor ? 'contained' : 'outlined'}
      startIcon={<AccountTreeRoundedIcon />}
      endIcon={<Stack className="node-menu-trigger-end" direction="row" alignItems="center" spacing={0.25}>
        <Chip size="small" label={project.nodes.length} className="node-menu-count" />
        <ExpandMoreRoundedIcon className={anchor ? 'node-menu-chevron is-open' : 'node-menu-chevron'} />
      </Stack>}
      aria-expanded={anchor !== null}
      aria-haspopup="dialog"
      aria-label={`Nodes, ${project.nodes.length} on canvas. Expand to add nodes`}
      className="canvas-header-control node-menu-trigger"
      onClick={event => setAnchor(event.currentTarget)}
    >
      Nodes
    </Button>
    <Popover
      open={anchor !== null}
      anchorEl={anchor}
      onClose={() => setAnchor(null)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { className: 'node-menu-paper' } }}
    >
      <Box className="node-menu" data-node-menu role="dialog" aria-label="Add nodes">
        <Stack className="node-menu-heading" direction="row" alignItems="center" justifyContent="space-between">
          <Box>
            <Typography variant="subtitle2">Add nodes</Typography>
            <Typography variant="caption" color="text.secondary">Choose a node to place on the canvas</Typography>
          </Box>
          <IconButton size="small" aria-label="Close node menu" onClick={() => setAnchor(null)}>
            <CloseRoundedIcon fontSize="small" />
          </IconButton>
        </Stack>
        <Box className="node-menu-content">
          <VisualPalette onAdd={onAdd} />
          <details className="node-menu-help">
            <summary><HelpOutlineRoundedIcon fontSize="small" /> Port colors</summary>
            <Box className="port-legend" aria-label="Port type colors">
              {PORT_LEGEND.map(port => <span key={port.label} className="port-legend-item">
                <i className="legend-dot" style={{ background: port.color }} aria-hidden="true" />
                {port.label}
              </span>)}
            </Box>
          </details>
        </Box>
      </Box>
    </Popover>
  </>;
}
