import { Box, Button, Stack } from '@mui/material';
import { describeGate } from './executionState';
import { ReceiptView } from './ReceiptView';
import type { ExecutionController } from './useWalletExecution';

/**
 * The execution action as its host sees it: the button that requests a
 * review, and the inline fallback for the receipt. Everything the user must
 * verify or watch happens in the centered execution dialog; these pieces
 * render around it. The receipt shows inline exactly while the dialog is
 * not showing it, so it is never rendered twice and never hidden.
 */

/** The button itself; it sits inline in whatever row hosts it. */
export function ExecuteButton({ execution }: { execution: ExecutionController }) {
  const { phase } = execution;
  // While a transaction is live the dialog owns the narration; a second
  // send would race the first, so the row says where things stand instead.
  if (phase.kind === 'awaiting-confirmation' || phase.kind === 'submitted') return null;
  return <Button size="small" variant="contained" disabled={!execution.canExecute}
    title={describeGate(execution.gate)} onClick={execution.review}>
    Execute program
  </Button>;
}

/** The receipt's inline home: visible only while the dialog is not showing it. */
export function ExecuteBlocks({ execution }: { execution: ExecutionController }) {
  if (execution.dialogOpen) return null;
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
