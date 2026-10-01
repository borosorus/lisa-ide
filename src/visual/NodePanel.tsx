import { Box, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import {
  BINARY_OPS, CONTEXT_NAMES, LITERAL_TYPES, WORD_DECODERS,
  type GraphNode, type GraphNodeDraft, type VisualProject,
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
      <Button size="small" variant="outlined" onClick={() => onAdd({ kind: 'return', decoder: 'uint256' }, 'ret')}>Decode</Button>
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
        : <TextField size="small" label="Value" value={node.literal} onChange={e => onChange({ literal: e.target.value })} />}
    </>}

    {node.kind === 'binary' && <SelectField label="Operation" value={node.op} options={[...BINARY_OPS]}
      render={op => OP_LABELS[op]} onChange={op => onChange({ op })} />}

    {node.kind === 'return' && <>
      <SelectField label="Decode" value={node.decoder} options={[...WORD_DECODERS]}
        onChange={decoder => onChange({ decoder, offset: decoder === 'word' ? node.offset ?? 0 : undefined })} />
      {node.decoder === 'word' && <TextField size="small" label="Word byte offset" value={node.offset ?? 0}
        onChange={e => {
          const value = Math.max(0, Math.trunc(Number(e.target.value)));
          onChange({ offset: Number.isSafeInteger(value) ? value : 0 });
        }} />}
    </>}

    {node.kind === 'call' && <Typography variant="body2" color="text.secondary">
      Call nodes come from dragging contract functions; they follow the contract resource address automatically.
    </Typography>}

    {ifs.length > 0 && <SelectField label="Inside IF block" value={node.parent ?? ''}
      options={['', ...ifs.map(n => n.id)]} render={id => id === '' ? 'Top level' : id}
      onChange={id => onChange({ parent: id === '' ? undefined : id })} />}
  </Stack>;
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
