import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Collapse, Dialog, DialogActions, DialogContent, DialogTitle,
  IconButton, InputAdornment, Paper, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import CodeRoundedIcon from '@mui/icons-material/CodeRounded';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import { isValidAddress, parseAbiJson } from './abi';
import { isReadFunction, type ContractFunction, type ContractResource } from './model';
import type { AuthoringMode } from './storage';

export const FUNCTION_MIME = 'application/lisa-function';

interface Props {
  mode: AuthoringMode;
  contracts: readonly ContractResource[];
  onAddContract: (contract: { name: string; address: string; functions: readonly ContractFunction[] }) => void;
  onUpdateContract: (id: string, patch: Partial<Pick<ContractResource, 'name' | 'address'>>) => void;
  onRemoveContract: (id: string) => void;
  /** Click-to-add: place the function's call node at a visible canvas spot. */
  onAddFunction: (contractId: string, signature: string) => void;
  onInsertFunction: (contract: ContractResource, fn: ContractFunction) => void;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function ContractsPanel({ mode, contracts, onAddContract, onUpdateContract, onRemoveContract, onAddFunction, onInsertFunction }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  function toggle(id: string) {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return <Box>
    <Button size="small" variant="outlined" onClick={() => setDialogOpen(true)} fullWidth startIcon={<AddRoundedIcon fontSize="small" />}>
      Add contract
    </Button>
    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
      {mode === 'visual'
        ? 'Click a function to add its node, or drag it onto the canvas.'
        : 'Click a function to insert a call template at the editor cursor.'}
    </Typography>
    {mode === 'code' && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
      Removing a contract also removes its visual call nodes.
    </Typography>}
    {contracts.length === 0 && (
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
        No contracts yet. Add one to use its ABI functions here.
      </Typography>
    )}
    {contracts.map(contract => (
      <ContractRow
        key={contract.id}
        contract={contract}
        expanded={expanded.has(contract.id)}
        onToggle={() => toggle(contract.id)}
        onPatch={onUpdateContract}
        onRemove={id => { onRemoveContract(id); setExpanded(current => { const next = new Set(current); next.delete(id); return next; }); }}
        onAddFunction={onAddFunction}
        mode={mode}
        onInsertFunction={onInsertFunction}
      />
    ))}
    <AddContractDialog
      open={dialogOpen}
      onClose={() => setDialogOpen(false)}
      onSubmit={contract => { onAddContract(contract); setDialogOpen(false); }}
    />
  </Box>;
}

function ContractRow({ contract, expanded, onToggle, onPatch, onRemove, onAddFunction, mode, onInsertFunction }: {
  contract: ContractResource;
  expanded: boolean;
  onToggle: () => void;
  onPatch: Props['onUpdateContract'];
  onRemove: (id: string) => void;
  onAddFunction: Props['onAddFunction'];
  mode: AuthoringMode;
  onInsertFunction: Props['onInsertFunction'];
}) {
  return <Paper variant="outlined" className={`contract-card${expanded ? ' contract-card-expanded' : ''}`}>
    <Stack className="contract-card-heading" direction="row" alignItems="center" spacing={0.75}>
      <Box
        component="button"
        type="button"
        className="contract-identity"
        onClick={onToggle}
        title={`${contract.name} · ${contract.address}`}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${contract.name}`}
        aria-expanded={expanded}
      >
        <ExpandMoreRoundedIcon className="contract-expand-icon" fontSize="small" />
        <Box className="contract-identity-copy">
          <Typography variant="body2" className="contract-name">{contract.name}</Typography>
          <Stack className="contract-summary" direction="row" alignItems="center" spacing={0.75}>
            <Typography component="span" variant="caption">{shortAddress(contract.address)}</Typography>
            <span className="contract-summary-divider" aria-hidden="true" />
            <Typography component="span" variant="caption">{contract.functions.length} functions</Typography>
          </Stack>
        </Box>
      </Box>
      <Tooltip title={`Remove ${contract.name}`}>
        <IconButton size="small" aria-label={`Remove ${contract.name}`} onClick={() => onRemove(contract.id)} className="contract-remove-button">
          <CloseRoundedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
    <Collapse in={expanded} unmountOnExit>
      <Box className="contract-details">
        <AddressEditor contract={contract} onPatch={onPatch} />
        <FunctionList contract={contract} mode={mode} onAddFunction={onAddFunction} onInsertFunction={onInsertFunction} />
      </Box>
    </Collapse>
  </Paper>;
}

function AddressEditor({ contract, onPatch }: { contract: ContractResource; onPatch: Props['onUpdateContract'] }) {
  const [text, setText] = useState(contract.address);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  useEffect(() => setText(contract.address), [contract.address]);

  function commit() {
    if (text === contract.address) return;
    const trimmed = text.trim();
    if (!isValidAddress(trimmed)) {
      setError('Address must be 20-byte hex.');
      setText(contract.address);
      return;
    }
    setError('');
    onPatch(contract.id, { address: trimmed });
  }

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(contract.address);
      setCopyFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  return <TextField
    size="small"
    value={text}
    onChange={event => { setText(event.target.value); setError(''); }}
    onBlur={commit}
    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}
    error={error.length > 0}
    helperText={error || 'Contract address'}
    fullWidth
    className="contract-address-field"
    sx={{ my: 0.75 }}
    slotProps={{
      input: {
        endAdornment: <InputAdornment position="end">
          <Tooltip title={copied ? 'Copied' : copyFailed ? 'Clipboard unavailable; select address to copy' : 'Copy address'}>
            <IconButton
              size="small"
              onClick={copyAddress}
              aria-label={copied ? `Copied address for ${contract.name}` : copyFailed ? `Copy unavailable for ${contract.name}` : `Copy address for ${contract.name}`}
              edge="end"
            >
              {copied ? <CheckRoundedIcon fontSize="small" /> : <ContentCopyRoundedIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        </InputAdornment>,
      },
      htmlInput: { 'aria-label': `Address for ${contract.name}`, style: { fontFamily: 'monospace', fontSize: '11px' } },
    }}
  />;
}

function FunctionList({ contract, mode, onAddFunction, onInsertFunction }: {
  contract: ContractResource;
  onAddFunction: Props['onAddFunction'];
  mode: AuthoringMode;
  onInsertFunction: Props['onInsertFunction'];
}) {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? contract.functions.filter(fn => fn.name.toLowerCase().includes(needle) || fn.signature.toLowerCase().includes(needle))
      : contract.functions;
    return {
      reads: filtered.filter(isReadFunction),
      writes: filtered.filter(fn => !isReadFunction(fn)),
    };
  }, [contract.functions, query]);

  return <Box>
    <TextField
      size="small"
      placeholder="Filter ABI functions"
      fullWidth
      className="contracts-search"
      value={query}
      onChange={e => setQuery(e.target.value)}
      slotProps={{
        input: { startAdornment: <InputAdornment position="start"><SearchRoundedIcon fontSize="small" /></InputAdornment> },
        htmlInput: { 'aria-label': `Search functions in ${contract.name}` },
      }}
    />
    <FunctionGroup label="Read" functions={matches.reads} contract={contract} mode={mode} onAddFunction={onAddFunction} onInsertFunction={onInsertFunction} />
    <FunctionGroup label="Write" functions={matches.writes} contract={contract} mode={mode} onAddFunction={onAddFunction} onInsertFunction={onInsertFunction} />
    {matches.reads.length + matches.writes.length === 0 && query && (
      <Typography variant="caption" color="text.secondary">No functions match.</Typography>
    )}
  </Box>;
}

function FunctionGroup({ label, functions, contract, mode, onAddFunction, onInsertFunction }: {
  label: string;
  functions: readonly ContractFunction[];
  contract: ContractResource;
  mode: AuthoringMode;
  onAddFunction: Props['onAddFunction'];
  onInsertFunction: Props['onInsertFunction'];
}) {
  if (functions.length === 0) return null;
  return <Box sx={{ mt: 0.5 }}>
    <Stack className="function-group-heading" direction="row" alignItems="center" justifyContent="space-between">
      <Typography variant="caption">{label} functions</Typography>
      <Typography component="span" variant="caption">{functions.length}</Typography>
    </Stack>
    {functions.map(fn => (
      <Button
        key={fn.signature}
        variant="outlined"
        fullWidth
        className="function-item"
        draggable={mode === 'visual'}
        onDragStart={event => {
          if (mode !== 'visual') return;
          event.dataTransfer.setData(FUNCTION_MIME, JSON.stringify({ contractId: contract.id, signature: fn.signature }));
          event.dataTransfer.effectAllowed = 'copy';
        }}
        onClick={() => mode === 'visual' ? onAddFunction(contract.id, fn.signature) : onInsertFunction(contract, fn)}
        title={mode === 'visual' ? `Click to add to the canvas, or drag onto it: ${fn.signature}` : `Insert ${isReadFunction(fn) ? 'staticCall' : 'call'} snippet: ${fn.signature}`}
        aria-label={fn.signature}
      >
        {/* Canonical signature, not the bare name: overloads must not look
            identical. Truncated on screen; full text in the tooltip. */}
        <Box component="span" className="function-signature">
          {fn.signature}
        </Box>
        <Box component="span" className="function-item-action" aria-hidden="true">
          {mode === 'visual' ? <AddRoundedIcon fontSize="small" /> : <CodeRoundedIcon fontSize="small" />}
          {mode === 'visual' ? 'Add' : 'Insert'}
        </Box>
      </Button>
    ))}
  </Box>;
}

/** Contained add-contract form; the panel itself never grows into a form. */
function AddContractDialog({ open, onClose, onSubmit }: {
  open: boolean;
  onClose: () => void;
  onSubmit: (contract: { name: string; address: string; functions: readonly ContractFunction[] }) => void;
}) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [abi, setAbi] = useState('');
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (open) { setName(''); setAddress(''); setAbi(''); setFormError(''); }
  }, [open]);

  function submit() {
    setFormError('');
    if (!name.trim()) return setFormError('Give the contract a name.');
    if (!isValidAddress(address.trim())) return setFormError('Address must be 20-byte hex, e.g. 0x1111…1111.');
    let parsed;
    try {
      parsed = parseAbiJson(abi);
    } catch (cause) {
      return setFormError(cause instanceof Error ? cause.message : String(cause));
    }
    if (parsed.functions.length === 0) {
      return setFormError(`No usable functions (${parsed.rejected.map(r => `${r.name}: ${r.reason}`).join('; ')})`);
    }
    onSubmit({ name: name.trim(), address: address.trim(), functions: parsed.functions });
  }

  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" slotProps={{ paper: { sx: { minHeight: 420 } } }}>
    <DialogTitle>Add contract</DialogTitle>
    <DialogContent>
      <Stack spacing={1.5} sx={{ mt: 0.5 }}>
        <TextField size="small" label="Name" value={name} onChange={e => setName(e.target.value)} fullWidth autoFocus />
        <TextField size="small" label="Address" value={address} onChange={e => setAddress(e.target.value)} fullWidth placeholder="0x…" />
        <TextField
          size="small" label="ABI JSON" value={abi} onChange={e => setAbi(e.target.value)}
          multiline minRows={6} maxRows={14} fullWidth placeholder='[{"type":"function","name":"balanceOf",…}]'
        />
        {formError && <Alert severity="error" sx={{ py: 0.5 }}>{formError}</Alert>}
      </Stack>
    </DialogContent>
    <DialogActions>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="contained" onClick={submit}>Add</Button>
    </DialogActions>
  </Dialog>;
}
