import { useState } from 'react';
import { Alert, Box, Button, Divider, Paper, Stack, TextField, Typography } from '@mui/material';
import { isValidAddress, parseAbiJson } from './abi';
import { isReadFunction, type ContractFunction, type ContractResource } from './model';

export const FUNCTION_MIME = 'application/lisa-function';

interface Props {
  contracts: readonly ContractResource[];
  onAddContract: (contract: { name: string; address: string; functions: readonly ContractFunction[] }) => void;
  onRemoveContract: (id: string) => void;
}

export function ContractsPanel({ contracts, onAddContract, onRemoveContract }: Props) {
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
      <Box key={contract.id}>
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Typography variant="subtitle2">{contract.name}</Typography>
          <Button size="small" color="inherit" aria-label={`Remove ${contract.name}`} onClick={() => onRemoveContract(contract.id)}>
            Remove
          </Button>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
          {contract.address}
        </Typography>
        <FunctionGroup label="Reads" functions={contract.functions.filter(isReadFunction)} contractId={contract.id} />
        <FunctionGroup
          label="Writes"
          functions={contract.functions.filter(f => !isReadFunction(f))}
          contractId={contract.id}
        />
      </Box>
    ))}
    {contracts.length === 0 && (
      <Typography variant="body2" color="text.secondary">No contracts yet. Add one to drag its functions onto the canvas.</Typography>
    )}
  </Stack>;
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
