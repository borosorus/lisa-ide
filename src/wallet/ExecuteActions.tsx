import { Box, Button, Stack } from '@mui/material';
import { describeGate } from './executionState';
import { ReceiptView } from './ReceiptView';
import type { ExecutionController } from './useWalletExecution';

/**
 * The execution action as its host sees it: the button that requests a
 * review, and the inline fallback for a pending or failed receipt. Final
 * success stays in the dialog while it is open and does not linger in Output.
 */

/** The button itself; it sits inline in whatever row hosts it. */
export function ExecuteButton({ execution }: { execution: ExecutionController }) {
  const { phase } = execution;
  // While a transaction is live the dialog owns the narration; a second
  // send would race the first, so the row says where things stand instead.
  if (phase.kind === 'awaiting-confirmation' || phase.kind === 'submitted') return null;
  return <Button size="small" color="secondary" variant="contained" disabled={!execution.canExecute}
    title={describeGate(execution.gate)} onClick={execution.review}>
    Execute program
  </Button>;
}

/** Pending and failure details survive dismissing the dialog; final success does not linger in Output. */
export function ExecuteBlocks({ execution }: { execution: ExecutionController }) {
  if (execution.dialogOpen || execution.phase.kind === 'confirmed') return null;
  return <ReceiptView phase={execution.phase} />;
}

/** The composed action block, as the Output panel places it. */
export function ExecuteActions({ execution }: { execution: ExecutionController }) {
  return <Box sx={{ mt: 2 }}>
    <Stack direction="row" alignItems="center" gap={1} sx={{ minHeight: 30 }}>
      <ExecuteButton execution={execution} />
    </Stack>
    <ExecuteBlocks execution={execution} />
  </Box>;
}
