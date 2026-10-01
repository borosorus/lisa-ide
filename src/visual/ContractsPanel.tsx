import { useEffect, useState } from 'react';
import { Alert, Box, Button, Divider, Paper, Stack, TextField, Typography } from '@mui/material';
import { isValidAddress, parseAbiJson } from './abi';
import { isReadFunction, type ContractFunction, type ContractResource } from './model';

export const FUNCTION_MIME = 'application/lisa-function';

interface Props {
  contracts: readonly ContractResource[];
  onAddContract: (contract: { name: string; address: string; functions: readonly ContractFunction[] }) => void;
  onUpdateContract: (id: string, patch: Partial<Pick<ContractResource, 'name' | 'address'>>) => void;
  onRemoveContract: (id: string) => void;
}

export function ContractsPanel({ contracts, onAddContract, onUpdateContract, onRemoveContract }: Props) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [abi, setAbi] = useState('');
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');

  function submit() {
    setFormError('');
    setNotice('');
    if (!name.trim()) return setFormError('Give the contract a name.');
    if (!isValidAddress(address.trim())) return setFormError('Address must be 20-byte hex, e.g. 0x1111…1111.');
    let parsed;
    try {
      parsed = parseAbiJson(abi);
    } catch (cause) {
      return setFormError(cause instanceof Error ? cause.message : String(cause));
    }
    const rejectionNote = parsed.rejected.length
      ? ` · ${parsed.rejected.length} function(s) skipped: ${parsed.rejected.map(r => r.name).join(', ')}`
      : '';
    onAddContract({ name: name.trim(), address: address.trim(), functions: parsed.functions });
    setNotice(`Added ${parsed.functions.length} function(s)${rejectionNote}`);
    setName(''); setAddress(''); setAbi('');
  }

  return <Stack spacing={1.5} sx={{ p: 2 }}>
    <Typography variant="subtitle2">Contract</Typography>
    <TextField size="small" label="Name" value={name} onChange={e => setName(e.target.value)} fullWidth />
    <TextField size="small" label="Address" value={address} onChange={e => setAddress(e.target.value)} fullWidth placeholder="0x…" />
    <TextField
      size="small" label="ABI JSON" value={abi} onChange={e => setAbi(e.target.value)}
      multiline minRows={3} maxRows={8} fullWidth placeholder='[{"type":"function","name":"balanceOf",…}]'
    />
    {formError && <Alert severity="error" sx={{ py: 0.5 }}>{formError}</Alert>}
    {notice && <Alert severity="info" sx={{ py: 0.5 }}>{notice}</Alert>}
    <Button variant="outlined" size="small" onClick={submit}>Add contract</Button>
    {contracts.length > 0 && <Divider sx={{ my: 0.5 }} />}
    {contracts.map(contract => (
      <ContractRow
        key={contract.id}
        contract={contract}
        onPatch={onUpdateContract}
        onRemove={onRemoveContract}
      />
    ))}
    {contracts.length === 0 && (
      <Typography variant="body2" color="text.secondary">No contracts yet. Add one to drag its functions onto the canvas.</Typography>
    )}
  </Stack>;
}

function ContractRow({ contract, onPatch, onRemove }: {
  contract: ContractResource;
  onPatch: (id: string, patch: Partial<Pick<ContractResource, 'name' | 'address'>>) => void;
  onRemove: (id: string) => void;
}) {
  const [text, setText] = useState(contract.address);
  const [error, setError] = useState('');
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

  return <Box>
    <Stack direction="row" alignItems="center" justifyContent="space-between">
      <Typography variant="subtitle2">{contract.name}</Typography>
      <Button size="small" color="inherit" aria-label={`Remove ${contract.name}`} onClick={() => onRemove(contract.id)}>
        Remove
      </Button>
    </Stack>
    <TextField
      size="small"
      value={text}
      onChange={event => { setText(event.target.value); setError(''); }}
      onBlur={commit}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}
      error={error.length > 0}
      helperText={error}
      fullWidth
      slotProps={{
        htmlInput: { 'aria-label': `Address for ${contract.name}`, style: { fontFamily: 'monospace', wordBreak: 'break-all' } },
      }}
    />
    <FunctionGroup label="Reads" functions={contract.functions.filter(isReadFunction)} contractId={contract.id} />
    <FunctionGroup label="Writes" functions={contract.functions.filter(f => !isReadFunction(f))} contractId={contract.id} />
  </Box>;
}

function FunctionGroup({ label, functions, contractId }: {
  label: string;
  functions: readonly ContractFunction[];
  contractId: string;
}) {
  if (functions.length === 0) return null;
  return <Box sx={{ mt: 0.5 }}>
    <Typography variant="caption" color="text.secondary">{label}</Typography>
    {functions.map(fn => (
      <Paper
        key={fn.signature}
        variant="outlined"
        className="function-item"
        draggable
        onDragStart={event => {
          event.dataTransfer.setData(FUNCTION_MIME, JSON.stringify({ contractId, signature: fn.signature }));
          event.dataTransfer.effectAllowed = 'copy';
        }}
        title={`Drag onto the canvas: ${fn.signature}`}
      >
        {fn.name}
      </Paper>
    ))}
  </Box>;
}
