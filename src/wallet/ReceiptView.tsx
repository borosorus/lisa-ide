import { Alert, AlertTitle, Box, CircularProgress, Stack, Typography } from '@mui/material';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import type { TransactionPhase } from './executionState';

type Presentation = 'dialog' | 'inline';

function TransactionDetails({ txHash, blockNumber }: { txHash: string; blockNumber?: number }) {
  return <Box component="dl" className={`transaction-details${blockNumber !== undefined ? ' transaction-details-confirmed' : ''}`}>
    <Box component="div" className="transaction-detail">
      <Typography component="dt" className="transaction-detail-label">Transaction hash</Typography>
      <Box component="dd" className="transaction-detail-value">{txHash}</Box>
    </Box>
    {blockNumber !== undefined && <Box component="div" className="transaction-detail-meta">
      <Typography component="dt" className="transaction-detail-label">Included in</Typography>
      <Typography component="dd" className="transaction-block-value">block {blockNumber}</Typography>
    </Box>}
  </Box>;
}

export function ReceiptView({ phase, presentation = 'inline' }: { phase: TransactionPhase; presentation?: Presentation }) {
  if (phase.kind === 'submitted') return <Box className={`transaction-pending transaction-pending-${presentation}`} role="status">
    <CircularProgress size={presentation === 'dialog' ? 27 : 20} thickness={4} aria-label="Waiting for transaction receipt" />
    <Box>
      <Typography className="transaction-pending-title">Submitted</Typography>
      <Typography variant="body2" color="text.secondary">Waiting for a receipt from the network.</Typography>
    </Box>
    {phase.txHash && <TransactionDetails txHash={phase.txHash} />}
  </Box>;

  if (phase.kind === 'confirmed') return <Stack className="transaction-result transaction-confirmed" spacing={2}>
    <Box className="transaction-success-hero">
      <Box className="transaction-success-mark"><CheckCircleRoundedIcon aria-hidden="true" /></Box>
      <Box>
        <Typography component="h2" className="transaction-result-title">Confirmed</Typography>
        <Typography variant="body2" color="text.secondary">Your program completed successfully.</Typography>
      </Box>
    </Box>
    <TransactionDetails txHash={phase.txHash} blockNumber={phase.blockNumber} />
  </Stack>;

  if (phase.kind === 'reverted') return <Stack className="transaction-result" spacing={1.25}>
    <Alert severity="error" className="transaction-alert">
      <AlertTitle>Reverted</AlertTitle>
      {phase.txHash
        ? 'The transaction was included in a block, but its execution reverted.'
        : 'Execution reverted before a transaction hash was available.'}
    </Alert>
    {phase.txHash && <TransactionDetails txHash={phase.txHash} />}
    <Typography variant="caption" color="text.secondary">Review the program and account state before trying again.</Typography>
  </Stack>;

  if (phase.kind === 'failed') return <Stack className="transaction-result" spacing={1.25}>
    <Alert severity={phase.txHash ? 'warning' : 'error'} className="transaction-alert">
      <AlertTitle>{phase.txHash ? 'Outcome not confirmed' : 'Failed'}</AlertTitle>
      {phase.message}
    </Alert>
    {phase.txHash && <TransactionDetails txHash={phase.txHash} />}
    <Typography variant="caption" color="text.secondary">
      {phase.txHash
        ? 'Check the transaction hash before retrying; it may already have been broadcast.'
        : 'This was not retried automatically. Run it again explicitly if intended.'}
    </Typography>
  </Stack>;

  return null;
}
