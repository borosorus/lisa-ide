import { useEffect, useRef } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';
import { ReceiptView } from './ReceiptView';
import type { ExecutionController } from './useWalletExecution';

/**
 * The execution window: the one place a program is verified before it can
 * touch a chain, in both authoring modes. It opens on an explicit review and
 * stays with the transaction through broadcast and receipt, so "Execute" is
 * never a click that quietly becomes a broadcast.
 *
 * Nothing here authorizes a send: Confirm is the only control that calls
 * send(), and the controller re-checks program, account, and chain against
 * live state regardless of what this window still happens to display (§14).
 */

export function ExecutionDialog({ execution }: { execution: ExecutionController }) {
  const { phase, output, session } = execution;
  const reviewing = phase.kind === 'review';
  // After broadcast the window becomes optional: closing it hands the receipt
  // to the inline fallback rather than abandoning anything. While the wallet
  // popup holds the transaction, closing would hide the only live status.
  const dismissible = phase.kind !== 'review' && phase.kind !== 'awaiting-confirmation';
  // Two clicks in one frame would call send() twice before the phase changes;
  // the second review checkpoint is far too late for a broadcast.
  const confirming = useRef(false);
  useEffect(() => {
    if (phase.kind !== 'awaiting-confirmation') confirming.current = false;
  }, [phase.kind]);
  const confirm = () => {
    if (confirming.current) return;
    confirming.current = true;
    void execution.send();
  };

  return <Dialog
    open={execution.dialogOpen}
    onClose={() => {
      if (reviewing) execution.cancelReview();
      else if (dismissible) execution.dismiss();
    }}
    // No exit animation: the moment this window is no longer open, the receipt
    // belongs to the inline surface. A lingering fade would show it twice.
    slotProps={{ transition: { exit: false } }}
    aria-labelledby="execution-dialog-title"
    maxWidth="sm" fullWidth
  >
    <DialogTitle id="execution-dialog-title">Execute program</DialogTitle>
    <DialogContent>
      {reviewing && output !== null && session.account !== null && <Stack spacing={1.25} sx={{ py: 0.5 }}>
        <Typography variant="overline" color="text.secondary">Destination — the transaction is sent to this account</Typography>
        <Box component="code" sx={{ overflowWrap: 'anywhere', fontSize: 13 }}>{session.account}</Box>
        <Typography variant="overline" color="text.secondary">Program hash</Typography>
        <Box component="code" sx={{ overflowWrap: 'anywhere', fontSize: 13 }}>{output.programHash}</Box>
        <Typography variant="body2" color="text.secondary">
          Chain {session.chainId ?? '?'} · {output.byteSize} bytes · executeLisa(bytes) · value 0 wei
        </Typography>
      </Stack>}
      {phase.kind === 'awaiting-confirmation' && (
        <Alert severity="info" sx={{ my: 0.5 }}>Confirm the transaction in your wallet. Nothing is broadcast until you do.</Alert>
      )}
      {dismissible && <ReceiptView phase={phase} />}
      {phase.kind === 'submitted' && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          Waiting for the receipt — it will also stay visible here if you close this window.
        </Typography>
      )}
    </DialogContent>
    <DialogActions sx={{ px: 3, pb: 2 }}>
      {reviewing && <>
        {/* Focus sits on the way out, not on the irreversible button. */}
        <Button onClick={execution.cancelReview} autoFocus>Cancel</Button>
        <Button variant="contained" onClick={confirm}>Confirm and send</Button>
      </>}
      {phase.kind === 'awaiting-confirmation' && <Typography variant="caption" color="text.secondary" sx={{ mr: 'auto' }}>Waiting for the wallet…</Typography>}
      {dismissible && <Button onClick={() => execution.dismiss()} autoFocus>Close</Button>}
    </DialogActions>
  </Dialog>;
}
