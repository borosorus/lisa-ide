import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/material';
import { describeGate, describePhase } from './executionState';
import type { ExecutionController } from './useWalletExecution';

/**
 * The execution action — button, review, receipt — as one component so the
 * whole flow lives wherever the program lives. Exactly one location renders
 * it at a time: the Output panel while it is open, the wallet strip while the
 * visual canvas has it collapsed. State lives in the controller, never here,
 * so the review never moves mid-flow.
 */

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** The button itself; it sits inline in whatever row hosts it. */
export function ExecuteButton({ execution }: { execution: ExecutionController }) {
  const { phase } = execution;
  if (phase.kind === 'awaiting-confirmation') {
    return <Typography variant="body2" color="text.secondary">{describePhase(phase)}</Typography>;
  }
  // While a receipt is awaited, the receipt row owns the status and a second
  // send would race the first. Once it settles, the action returns.
  if (phase.kind === 'submitted') return null;
  return <Button size="small" variant="contained" disabled={!execution.canExecute}
    title={describeGate(execution.gate)} onClick={execution.review}>
    Execute program
  </Button>;
}

/** Review and receipt surfaces; they expand directly below their button. */
export function ExecuteBlocks({ execution }: { execution: ExecutionController }) {
  const { phase, output, session } = execution;
  return <>
    {phase.kind === 'review' && output !== null && session.account !== null && <>
      <Alert severity="info" sx={{ mt: 1 }}>
        <Stack spacing={0.5}>
          <Typography variant="body2">Destination (transaction is sent to this account)</Typography>
          <Box component="code" sx={{ overflowWrap: 'anywhere' }}>{session.account}</Box>
          <Typography variant="body2">Program hash</Typography>
          <Box component="code" sx={{ overflowWrap: 'anywhere' }}>{output.programHash}</Box>
          <Typography variant="body2">
            {output.byteSize} bytes · executeLisa(bytes) · value 0 wei · chain {session.chainId ?? '?'}
          </Typography>
        </Stack>
      </Alert>
      <Stack direction="row" gap={1} sx={{ mt: 1 }}>
        <Button size="small" color="primary" variant="contained" onClick={() => void execution.send()}>Confirm and send</Button>
        <Button size="small" onClick={execution.cancelReview}>Cancel</Button>
      </Stack>
    </>}

    {(phase.kind === 'submitted' || phase.kind === 'confirmed' || phase.kind === 'reverted' || phase.kind === 'failed') && <>
      <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
        <Chip
          size="small"
          color={phase.kind === 'confirmed' ? 'success' : phase.kind === 'reverted' || phase.kind === 'failed' ? 'error' : 'default'}
          label={describePhase(phase) || 'Failed'}
        />
        {phase.txHash !== '' && <Typography variant="caption" component="code" sx={{ overflowWrap: 'anywhere' }}>{phase.txHash}</Typography>}
        {phase.kind === 'confirmed' && <Typography variant="caption" color="text.secondary">block {phase.blockNumber}</Typography>}
      </Stack>
      {phase.kind === 'failed' && <Alert severity="error" sx={{ mt: 1 }}>{phase.message}</Alert>}
      {(phase.kind === 'reverted' || phase.kind === 'failed') && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          Not retried automatically — run it again explicitly if intended.
        </Typography>
      )}
    </>}
  </>;
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
