import { Alert, Box, Button, Chip, Divider, Paper, Stack, Typography } from '@mui/material';
import { describeGate } from './executionState';
import { ExecuteBlocks, ExecuteButton } from './ExecuteActions';
import type { ExecutionController } from './useWalletExecution';

/**
 * The wallet strip: session identity and LISA readiness, one row shared by
 * both authoring modes. It is a pure view of the execution controller — the
 * Execute action renders here only while the Output panel is collapsed in
 * visual mode; while it is open, the action lives beside the program.
 */

interface Props {
  readonly execution: ExecutionController;
  /** Where the Execute action currently lives; exactly one location renders it. */
  readonly executeLocation?: 'strip' | 'output';
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletExecutionPanel({ execution, executeLocation = 'strip' }: Props) {
  const { session, gate, phase, alert } = execution;
  const statusColor = gate.kind === 'ready' ? 'success' : gate.kind === 'inspecting' || gate.kind === 'wallet-connecting' ? 'default' : 'warning';

  return <Paper className="wallet-strip" elevation={0} variant="outlined">
    <Stack direction="row" alignItems="center" gap={1.5} flexWrap="wrap" useFlexGap>
      <Typography variant="overline" color="text.secondary">Wallet</Typography>
      {session.status === 'ready' && session.account !== null
        ? <>
          <Typography variant="body2" component="code" title={session.account}>{shortAddress(session.account)}</Typography>
          <Chip size="small" label={`Chain ${session.chainId ?? '?'}`} />
          <Button size="small" onClick={() => void session.disconnectWallet()}>Disconnect</Button>
        </>
        : <Button size="small" variant="outlined" disabled={session.status === 'loading'}
            onClick={() => void session.connectWallet()}>
          {session.status === 'loading' ? 'Connecting…' : 'Connect wallet'}
        </Button>}
      <Divider orientation="vertical" flexItem />
      <Typography variant="overline" color="text.secondary">LISA</Typography>
      <Chip size="small" color={statusColor} data-testid="lisa-status" label={describeGate(gate)} />
      {gate.kind === 'ready' && <Chip size="small" variant="outlined" label={`Runtime ${gate.runtime}`} />}
      {executeLocation === 'strip' && <Box sx={{ ml: 'auto' }}><ExecuteButton execution={execution} /></Box>}
    </Stack>
    {executeLocation === 'strip' && alert !== null && phase.kind !== 'review' && <Alert
      severity={alert.severity} sx={{ mt: 1 }} role="status"
      action={gate.kind === 'wrong-chain'
        ? <Button size="small" color="inherit" disabled={execution.switching} onClick={() => void execution.requestSwitch()}>
          {execution.switching ? 'Switching…' : 'Switch network'}
        </Button>
        : undefined}>
      {alert.text}
      {gate.kind === 'wrong-chain' && execution.switchMessage !== null
        && <Box component="div" sx={{ mt: 0.5 }}>{execution.switchMessage}</Box>}
    </Alert>}
    {executeLocation === 'strip' && <ExecuteBlocks execution={execution} />}
  </Paper>;
}
