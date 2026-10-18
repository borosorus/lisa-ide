import { useEffect, useRef } from 'react';
import { Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';
import { ReceiptView } from './ReceiptView';
import type { TransactionPhase } from './executionState';
import type { ExecutionController } from './useWalletExecution';

const FLOW_STEPS = ['Review', 'Wallet', 'Receipt'] as const;

function ExecutionFlow({ phase }: { phase: TransactionPhase }) {
  let activeStep = 0;
  if (phase.kind === 'awaiting-confirmation') activeStep = 1;
  if (phase.kind === 'submitted' || phase.kind === 'confirmed') activeStep = 2;
  if (phase.kind === 'reverted') activeStep = phase.txHash ? 2 : 1;
  if (phase.kind === 'failed') activeStep = phase.txHash ? 2 : 1;
  const failed = phase.kind === 'failed' || phase.kind === 'reverted';
  const failedStep = failed && !phase.txHash ? 1 : 2;

  return <Box component="ol" className="execution-flow" aria-label="Transaction progress">
    {FLOW_STEPS.map((step, index) => {
      const isFailed = failed && index === failedStep;
      const state = isFailed ? 'error' : index < activeStep || phase.kind === 'confirmed' ? 'complete' : index === activeStep ? 'current' : 'upcoming';
      return <Box component="li" className={`execution-flow-step execution-flow-${state}`} key={step}
        aria-current={state === 'current' || state === 'error' ? 'step' : undefined}>
        <Box className="execution-flow-marker">{state === 'complete' ? '✓' : isFailed ? '!' : index + 1}</Box>
        <Typography component="span" className="execution-flow-label">{step}</Typography>
      </Box>;
    })}
  </Box>;
}

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
  // After broadcast the window becomes optional: pending and failure details
  // can move inline on close. While the wallet popup holds the transaction,
  // closing would hide the only live status.
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
    {phase.kind !== 'idle' && <ExecutionFlow phase={phase} />}
    <DialogContent>
      {reviewing && output !== null && session.account !== null && <Stack className="execution-review" spacing={1.25} sx={{ py: 0.5 }}>
        <Typography variant="body2" color="text.secondary">
          Review the destination and compiled program. Your wallet will ask you to approve before anything is sent.
        </Typography>
        <Box className="execution-review-field">
          <Typography component="div" className="execution-review-label">Destination account</Typography>
          <Box component="code" className="execution-review-value">{session.account}</Box>
          <Typography variant="caption" color="text.secondary" display="block">The transaction executes through this account.</Typography>
        </Box>
        <Box className="execution-review-field">
          <Typography component="div" className="execution-review-label">Program hash</Typography>
          <Box component="code" className="execution-review-value">{output.programHash}</Box>
        </Box>
        <Box className="execution-review-meta">
          <Box><Typography component="div" className="execution-review-label">Network</Typography><Typography variant="body2">Chain {session.chainId ?? '?'}</Typography></Box>
          <Box><Typography component="div" className="execution-review-label">Payload</Typography><Typography variant="body2">{output.byteSize} bytes</Typography></Box>
          <Box><Typography component="div" className="execution-review-label">Method</Typography><Typography variant="body2" className="execution-review-mono">executeLisa(bytes)</Typography></Box>
          <Box><Typography component="div" className="execution-review-value-pair">Value <br />0 wei</Typography></Box>
        </Box>
      </Stack>}
      {phase.kind === 'awaiting-confirmation' && (
        <Box className="transaction-preparing" role="status">
          <Box className="transaction-preparing-spinner"><CircularProgress size={30} thickness={4} aria-label="Waiting for wallet approval" /></Box>
          <Box>
            <Typography component="h2" className="transaction-result-title">Waiting for wallet approval</Typography>
            <Typography variant="body2" color="text.secondary">We’re checking your wallet and network. Review and approve the request in your wallet when it appears. Nothing is broadcast until then.</Typography>
          </Box>
        </Box>
      )}
      {dismissible && <ReceiptView phase={phase} presentation="dialog" />}
      {phase.kind === 'submitted' && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          You can close this dialog. Receipt tracking continues in the Output pane.
        </Typography>
      )}
    </DialogContent>
    {(reviewing || dismissible) && <DialogActions sx={{ px: 3, pb: 2 }}>
      {reviewing && <>
        {/* Focus sits on the way out, not on the irreversible button. */}
        <Button onClick={execution.cancelReview} autoFocus>Cancel</Button>
        <Button color="secondary" variant="contained" onClick={confirm}>Confirm and send</Button>
      </>}
      {dismissible && <Button color="primary" variant="contained" onClick={() => execution.dismiss()} autoFocus>Close</Button>}
    </DialogActions>}
  </Dialog>;
}
