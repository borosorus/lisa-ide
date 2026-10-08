import { Alert, Chip, Stack, Typography } from '@mui/material';
import { describePhase, type TransactionPhase } from './executionState';

/**
 * The transaction receipt: the hash as the thread to follow, and what became
 * of it. Shared so the execution dialog and the inline fallback can never
 * disagree about the one artifact the user may need to carry away.
 */
export function ReceiptView({ phase }: { phase: TransactionPhase }) {
  if (phase.kind !== 'submitted' && phase.kind !== 'confirmed'
    && phase.kind !== 'reverted' && phase.kind !== 'failed') return null;
  return <>
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
  </>;
}
