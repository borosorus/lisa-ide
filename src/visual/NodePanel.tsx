import { useEffect, useState } from 'react';
import { Box, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import {
  BINARY_OPS, CONTEXT_NAMES, isValidLiteral, LITERAL_TYPES,
  type GraphNode, type GraphNodeDraft, type LiteralType, type VisualProject,
} from './model';

/** Sidebar: create nodes, and edit the fields of the selected node. */

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

const OP_LABELS: Record<string, string> = {
  add: 'add (+)', sub: 'subtract (−)', mul: 'multiply (×)', div: 'divide (÷)',
  lt: 'less than (<)', gt: 'greater than (>)', eq: 'equals (=)',
};

export function NodeInspector({ node, project, onChange }: {
  node: GraphNode | null;
  project: VisualProject;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  if (!node) {
    return <Typography variant="body2" color="text.secondary">Select a node to edit it, or drag a contract function onto the canvas.</Typography>;
  }
  const ifs = project.nodes.filter(n => n.kind === 'if' && n.id !== node.id);
  return <Stack spacing={1.2}>
    <Typography variant="subtitle2">{node.kind} · {node.id}</Typography>

    {node.kind === 'context' && <SelectField label="Context value" value={node.name} options={[...CONTEXT_NAMES]}
      onChange={name => onChange({ name })} />}

    {node.kind === 'literal' && <>
      <SelectField label="Literal type" value={node.literalType} options={[...LITERAL_TYPES]}
        onChange={literalType => onChange({ literalType, literal: literalType === 'bool' ? 'true' : literalType === 'address' ? '0x0000000000000000000000000000000000000000' : '0' })} />
      {node.literalType === 'bool'
        ? <SelectField label="Value" value={node.literal} options={['true', 'false']} onChange={literal => onChange({ literal })} />
        : <LiteralField type={node.literalType} value={node.literal} onCommit={literal => onChange({ literal })} />}
    </>}

    {node.kind === 'binary' && <SelectField label="Operation" value={node.op} options={[...BINARY_OPS]}
      render={op => OP_LABELS[op]} onChange={op => onChange({ op })} />}

    {node.kind === 'call' && <Typography variant="body2" color="text.secondary">
      Call nodes come from dragging contract functions; they follow the contract resource address automatically.
    </Typography>}

    {ifs.length > 0 && <SelectField label="Inside IF block" value={node.parent ?? ''}
      options={['', ...ifs.map(n => n.id)]} render={id => id === '' ? 'Top level' : id}
      onChange={id => onChange({ parent: id === '' ? undefined : id })} />}
  </Stack>;
}

/**
 * Free-text literal editor: commits only text the graph grammar accepts, so
 * mid-typed values never reach the project (and thus never reach storage,
 * whose parser would otherwise drop the node on reload).
 */
function LiteralField({ type, value, onCommit }: {
  type: LiteralType;
  value: string;
  onCommit: (literal: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return <TextField
    size="small" label="Value" value={text}
    error={!isValidLiteral(type, text)}
    onChange={event => {
      setText(event.target.value);
      if (isValidLiteral(type, event.target.value)) onCommit(event.target.value);
    }}
    onBlur={() => { if (!isValidLiteral(type, text)) setText(value); }}
  />;
}

function SelectField({ label, value, options, onChange, render }: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  render?: (value: string) => string;
}) {
  return <TextField select size="small" label={label} value={value}
      onChange={e => onChange(e.target.value)}>
    {options.map(option => <MenuItem key={option} value={option}>{render ? render(option) : option}</MenuItem>)}
  </TextField>;
}
