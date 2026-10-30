import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  IconButton, List, ListItem, ListItemText, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import { isAddress } from 'ethers';
import { normalizeError } from './errors';
import type { SafeAddress } from './safe';
import { safeAddressKey } from './safeSettings';
import type { ExecutionController } from './useWalletExecution';

/**
 * The Safe address book. Executing through a Safe is a standing choice about a
 * specific contract on a specific chain, so it gets its own window rather than a
 * text field in the strip: an address is verified once, here, and then either
 * used or removed, with the chain it belongs to always visible (§5).
 *
 * Nothing in this window executes: choosing a Safe only changes the target the
 * review will describe. The verification it performs is the same inspection
 * execution performs, and the refusal is the strip's own sentence (§14).
 */

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly execution: ExecutionController;
}

/**
 * A raw address is too long for a row and the tail is what distinguishes Safes
 * created from the same factory, so both ends are kept.
 */
function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function SafeAccountsDialog({ open, onClose, execution }: Props) {
  const { session, activeSafe, savedSafes } = execution;
  const [address, setAddress] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = pending !== null;
  const chainId = session.chainId;
  // A refusal belongs to the attempt that produced it; reopening asks again.
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const typed = address.trim();
  const parsed = typed !== '' && isAddress(typed) ? typed : null;
  const typedInvalid = typed !== '' && parsed === null;
  const canVerify = !busy && chainId !== null && parsed !== null;

  async function choose(target: SafeAddress) {
    const key = safeAddressKey(target);
    setPending(key);
    setError(null);
    try {
      await execution.selectSafe(target.address, target.chainId);
      setAddress('');
      onClose();
    } catch (cause) {
      setError(normalizeError(cause).message);
    } finally {
      setPending(null);
    }
  }

  const isActive = (entry: SafeAddress) => activeSafe !== null && safeAddressKey(activeSafe) === safeAddressKey(entry);

  /**
   * The window stays open until a running verification answers: closing it would
   * leave a read in flight that can still change the execution target after the
   * user has moved on. Escape and a backdrop click are the same request.
   */
  const requestClose = () => {
    if (!busy) onClose();
  };

  return <Dialog
    open={open}
    onClose={requestClose}
    aria-labelledby="safe-accounts-title"
    // No exit animation: once a Safe is verified this window is gone and the strip
    // is the only place the target is shown, so a lingering fade would show both.
    slotProps={{ transition: { exit: false } }}
    maxWidth="sm"
    fullWidth
  >
    <DialogTitle id="safe-accounts-title">Safe accounts</DialogTitle>
    <DialogContent>
      <Stack spacing={1.5} sx={{ pt: 0.5 }}>
        <Alert severity="info">
          Saved addresses stay in this browser, so you do not paste one every reload. Choosing a Safe verifies it on
          chain first: it must be a single-owner Safe (version 1.3.0 or 1.4.1), the connected account must be an owner,
          and the configured LISA runtime must have code on that chain.
        </Alert>
        {session.account === null && <Alert severity="warning">
          Connect the owner wallet to verify and use a Safe. Saved addresses are shown meanwhile.
        </Alert>}

        {activeSafe !== null && <Box>
          <Typography variant="overline" color="text.secondary">Executing through</Typography>
          <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap" useFlexGap>
            <Box component="code" title={activeSafe.address} sx={{ wordBreak: 'break-all' }}>{activeSafe.address}</Box>
            <Chip size="small" label={`Chain ${activeSafe.chainId}`} />
            <Button size="small" variant="outlined" disabled={busy} onClick={execution.clearSafe}>
              Stop using this Safe
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary" display="block">
            The program then runs as the Safe, not as the connected account. Stopping keeps the address saved.
          </Typography>
        </Box>}

        <Box>
          <Typography variant="overline" color="text.secondary">Saved Safes</Typography>
          {savedSafes.length === 0
            ? <Typography variant="body2" color="text.secondary">
                No Safe addresses saved in this browser yet. Add one below; it is remembered once it verifies.
              </Typography>
            : <List dense disablePadding aria-label="Saved Safe addresses">
                {savedSafes.map(entry => {
                  const key = safeAddressKey(entry);
                  const active = isActive(entry);
                  const elsewhere = entry.chainId !== chainId;
                  return <ListItem
                    key={key}
                    disableGutters
                    secondaryAction={<Stack direction="row" alignItems="center" gap={0.5}>
                      {active && <Chip size="small" color="secondary" label="Active" />}
                      {/* An entry on another chain is "active" and still not the
                          contract it names here, so it needs the switch as well. */}
                      {(!active || elsewhere) && <Button size="small" disabled={busy || session.account === null}
                        aria-label={`${elsewhere ? 'Switch network and use' : 'Use'} Safe ${shortAddress(entry.address)} on chain ${entry.chainId}`}
                        onClick={() => void choose(entry)}>
                        {elsewhere ? 'Switch network' : 'Use'}
                      </Button>}
                      {pending === key && <CircularProgress size={16} aria-label={`Verifying Safe ${shortAddress(entry.address)}`} />}
                      <Tooltip title="Remove from this browser">
                        <span>
                          <IconButton size="small" disabled={busy}
                            aria-label={`Remove saved Safe ${shortAddress(entry.address)} on chain ${entry.chainId}`}
                            onClick={() => execution.removeSafe(entry.address, entry.chainId)}>
                            <DeleteOutlineRoundedIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Stack>}
                  >
                    <ListItemText
                      primary={<Box component="code" title={entry.address} sx={{ wordBreak: 'break-all' }}>{entry.address}</Box>}
                      secondary={<Typography variant="caption" color="text.secondary" component="span">
                        Chain {entry.chainId}{elsewhere ? ' · not the connected network' : ''}
                      </Typography>}
                    />
                  </ListItem>;
                })}
              </List>}
        </Box>

        <Box>
          <Typography variant="overline" color="text.secondary">Add a Safe address</Typography>
          <TextField
            size="small"
            fullWidth
            label="Safe address"
            value={address}
            disabled={busy}
            error={typedInvalid}
            helperText={typedInvalid
              ? 'That is not a 20-byte address.'
              : chainId === null
                ? 'Connect a wallet to verify a Safe on its chain.'
                : session.account === null
                  ? `Will be verified on chain ${chainId}.`
                  : `Will be verified on chain ${chainId} as ${shortAddress(session.account)}.`}
            onChange={event => {
              setAddress(event.target.value);
              // A refusal belongs to the address that produced it.
              setError(null);
            }}
          />
        </Box>

        {error !== null && <Alert severity="error">{error}</Alert>}
      </Stack>
    </DialogContent>
    <DialogActions sx={{ px: 3, pb: 2 }}>
      <Button onClick={requestClose} disabled={busy}>Close</Button>
      <Button color="secondary" variant="contained" disabled={!canVerify}
        onClick={() => { if (chainId !== null && parsed !== null) void choose({ address: parsed, chainId }); }}>
        Verify and remember Safe
      </Button>
    </DialogActions>
  </Dialog>;
}
