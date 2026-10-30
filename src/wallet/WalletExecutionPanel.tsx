import { Button, Chip, Divider, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import SwapHorizRoundedIcon from '@mui/icons-material/SwapHorizRounded';
import TaskAltRoundedIcon from '@mui/icons-material/TaskAltRounded';
import { useState } from 'react';
import { describeGate, type ExecutionGate } from './executionState';
import { SafeAccountsDialog } from './SafeAccountsDialog';
import type { ExecutionController } from './useWalletExecution';

/**
 * The wallet strip: session identity, execution target, and LISA readiness, one
 * row shared by both authoring modes. It is a pure view of the execution
 * controller and a pure status surface — the Execute action belongs to the
 * Output pane, the program's own home, and the review itself happens in the
 * centered dialog. Choosing a Safe happens in its own dialog, because it is a
 * standing choice with an address book behind it (§5).
 */

interface Props {
  readonly execution: ExecutionController;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function gateSummary(gate: ExecutionGate): string {
  switch (gate.kind) {
    case 'ready': return 'Ready';
    case 'wallet-disconnected': return 'Disconnected';
    case 'wallet-connecting': return 'Connecting';
    case 'wallet-error': return 'Wallet error';
    case 'unconfigured': return 'Not configured';
    case 'invalid-config': return 'Invalid config';
    case 'wrong-chain': return 'Wrong network';
    case 'inspecting': return 'Checking';
    case 'undelegated': return 'Not delegated';
    case 'other-delegation': return 'Wrong delegation';
    case 'invalid-delegation': return 'Invalid delegation';
    case 'invalid-lisa': return 'Invalid account';
    case 'runtime-mismatch': return 'Runtime mismatch';
    case 'runtime-no-code': return 'Runtime unavailable';
    case 'rpc-error': return 'Inspection failed';
    case 'no-program': return 'No program';
    case 'safe-other-chain': return 'Safe on another network';
    case 'safe-address-invalid': return 'Invalid Safe address';
    case 'safe-no-code': return 'Safe not deployed';
    case 'safe-not-a-safe': return 'Not a Safe';
    case 'safe-unsupported-version': return 'Unsupported Safe';
    case 'safe-not-owner': return 'Not a Safe owner';
    case 'safe-threshold': return 'Multi-owner Safe';
    case 'ready-safe': return 'Ready (Safe)';
  }
}

export function WalletExecutionPanel({ execution }: Props) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [safeDialogOpen, setSafeDialogOpen] = useState(false);
  const { session, gate, phase, alert, activeSafe } = execution;
  const ready = gate.kind === 'ready' || gate.kind === 'ready-safe';
  // Changing where a program runs while it is being signed or tracked would make
  // the strip disagree with the transaction it is describing.
  const busy = phase.kind === 'awaiting-confirmation' || phase.kind === 'submitted';
  const statusColor = ready ? 'success'
    : gate.kind === 'inspecting' || gate.kind === 'wallet-connecting' ? 'default'
      : alert?.severity === 'error' ? 'error' : 'warning';
  const statusDetails = [describeGate(gate), alert?.text, execution.switchMessage].filter(Boolean).join('\n\n');
  // The switch icon is the one affordance for either chain refusal: the wallet is
  // on the wrong network, or the chosen Safe is pinned to a different one.
  const switchChain = gate.kind === 'wrong-chain' || gate.kind === 'safe-other-chain' ? gate.expected : null;

  async function copyAddress(address: string) {
    if (!navigator.clipboard?.writeText) {
      setCopied(false);
      setCopyFailed(true);
      return;
    }
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  return <>
    <Paper className="wallet-strip" elevation={0} variant="outlined">
      <Stack direction="row" alignItems="center" gap={1.5} flexWrap="wrap" useFlexGap>
        <Typography variant="overline" color="text.secondary">Wallet</Typography>
        {session.status === 'ready' && session.account !== null
          ? <>
            <Typography variant="body2" component="code" title={session.account}>{shortAddress(session.account)}</Typography>
            <Tooltip title={copied ? 'Address copied' : copyFailed ? 'Could not copy address' : 'Copy address'}>
              <IconButton
                size="small"
                aria-label="Copy wallet address"
                onClick={() => void copyAddress(session.account!)}
              >
                {copied ? <CheckRoundedIcon fontSize="inherit" /> : <ContentCopyRoundedIcon fontSize="inherit" />}
              </IconButton>
            </Tooltip>
            <Chip size="small" label={`Chain ${session.chainId ?? '?'}`} />
            <Button size="small" variant="outlined" onClick={() => void session.disconnectWallet()}>Disconnect</Button>
          </>
          : <Button size="small" variant="outlined" disabled={session.status === 'loading'}
              onClick={() => void session.connectWallet()}>
            {session.status === 'loading' ? 'Connecting…' : 'Connect wallet'}
          </Button>}
        <Divider orientation="vertical" flexItem />
        <Typography variant="overline" color="text.secondary">Execute through</Typography>
        {/* One button, not a toggle plus a field: the target is a standing choice
            with an address book behind it, and it has to stay readable while a
            program is being reviewed. */}
        <Tooltip title={activeSafe === null
          ? "Execute through a single-owner Safe instead of this account's own delegation"
          : `Executing through Safe ${activeSafe.address} on chain ${activeSafe.chainId}`}>
          <span>
            <Button size="small" disabled={busy}
              variant={activeSafe === null ? 'outlined' : 'contained'}
              color={activeSafe === null ? 'primary' : 'secondary'}
              onClick={() => setSafeDialogOpen(true)}>
              {activeSafe === null ? 'Use Safe' : `Safe ${shortAddress(activeSafe.address)}`}
            </Button>
          </span>
        </Tooltip>
        <Divider orientation="vertical" flexItem />
        <Typography variant="overline" color="text.secondary">LISA</Typography>
        <Chip size="small" color={statusColor} label={gateSummary(gate)} />
        <span className="sr-only" data-testid="lisa-status">{describeGate(gate)}</span>
        {ready && <Chip size="small" variant="outlined" title={gate.runtime} label={`Runtime ${shortAddress(gate.runtime)}`} />}
        {alert !== null && phase.kind !== 'review' && <>
          <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{statusDetails}</span>}>
            <IconButton size="small" aria-label="LISA status details">
              {alert.severity === 'error'
                ? <ErrorOutlineRoundedIcon fontSize="small" color="error" />
                : <InfoOutlinedIcon fontSize="small" color="info" />}
            </IconButton>
          </Tooltip>
          {switchChain !== null && <Tooltip title={`Switch to chain ${switchChain}`}>
            <span>
              <IconButton size="small" aria-label="Switch network" disabled={execution.switching}
                onClick={() => void execution.requestSwitch(switchChain)}>
                <SwapHorizRoundedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>}
        </>}
        {ready && <Tooltip title={gate.kind === 'ready-safe'
          ? 'The Safe will delegatecall the runtime for this program'
          : 'LISA account is ready to execute this program'}>
          <TaskAltRoundedIcon fontSize="small" color="success" aria-label="LISA ready" />
        </Tooltip>}
      </Stack>
      {alert !== null && phase.kind !== 'review' && <span className="sr-only" role="status">{statusDetails}</span>}
    </Paper>
    <SafeAccountsDialog open={safeDialogOpen} onClose={() => setSafeDialogOpen(false)} execution={execution} />
  </>;
}
