import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, Divider, Paper, Stack, Typography } from '@mui/material';
import type { CompileOutput } from '../compile/types';
import { inspectLisaAccount } from '../lisa-account/inspect';
import { prepareExecuteLisaTransaction } from '../lisa-account/execute';
import { LisaError } from '../lisa-account/types';
import { DEPLOYMENT, deploymentLabel } from './deployment';
import { normalizeError } from './errors';
import {
  canExecute, deriveGate, describeGate, describePhase, IDLE,
  normalizeChainId,
  type ExecutionGate, type Inspection, type SessionSnapshot, type TransactionPhase,
} from './executionState';
import { useWalletSession } from './session';

/**
 * The whole wallet surface (AGENTS.md §7, §8, §14): one compact strip. It consumes
 * the CompileOutput the IDE is already showing — it never compiles (§6) and never
 * touches a private key (§14). Native value is fixed at 0 (§9).
 */

interface Props {
  readonly output: CompileOutput | null;
  /** Overridable for tests; production builds use the env-derived config (§3). */
  readonly config?: typeof DEPLOYMENT;
}

const TX_FACTS = new Set(['submitted', 'confirmed', 'reverted']);

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** A phase that reports an on-chain fact survives an account switch; intent does not. */
function keepPhase(phase: TransactionPhase): boolean {
  return TX_FACTS.has(phase.kind);
}

function gateAlert(gate: ExecutionGate): { severity: 'error' | 'info' | 'success'; text: string } | null {
  switch (gate.kind) {
    case 'wallet-disconnected': return { severity: 'info', text: 'Connect a wallet to inspect its LisaAccount.' };
    case 'wallet-error': return { severity: 'error', text: gate.reason };
    case 'unconfigured': return { severity: 'info', text: `LISA deployment not configured. ${deploymentLabel()}` };
    case 'invalid-config': return { severity: 'error', text: deploymentLabel({ kind: 'invalid', reason: gate.reason }) };
    case 'undelegated': return { severity: 'info', text: 'This account has no EIP-7702 delegation. Execution stays disabled until it is delegated to the configured LisaAccount.' };
    case 'other-delegation': return { severity: 'error', text: `Account is delegated to ${gate.implementation}, not the configured LisaAccount implementation.` };
    case 'invalid-delegation': return { severity: 'error', text: `Delegation designator is malformed: ${gate.reason}` };
    case 'invalid-lisa': return { severity: 'error', text: `Delegated to the configured LisaAccount but ${gate.reason}` };
    case 'runtime-mismatch': return { severity: 'error', text: `LisaAccount runtime ${gate.runtime} does not match the configured runtime ${gate.expected}.` };
    case 'rpc-error': return { severity: 'error', text: gate.reason };
    case 'no-program': return { severity: 'info', text: 'Account is ready. Compile a program to enable execution.' };
    default: return null;
  }
}

export function WalletExecutionPanel({ output, config = DEPLOYMENT }: Props) {
  const session = useWalletSession();
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [phase, setPhase] = useState<TransactionPhase>(IDLE);
  const reviewing = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false }, []);

  const snapshot = useMemo<SessionSnapshot>(() => ({
    status: session.status, account: session.account, chainId: session.chainId, message: session.message,
  }), [session.status, session.account, session.chainId, session.message]);
  const gate = deriveGate({
    session: snapshot, config, inspection, inspectionError, hasProgram: output !== null,
  });

  // Inspect the account the session is on now; a result for any other
  // account/chain pair is never usable, so the key is stored with it (§14).
  const { reader, account, chainId } = session;
  useEffect(() => {
    setInspection(null);
    setInspectionError(null);
    if (reader === null || account === null || chainId === null || config.kind !== 'configured') return;
    let live = true;
    void (async () => {
      try {
        const status = await inspectLisaAccount(reader, account, config);
        if (live && mounted.current) setInspection({ account, chainId, status });
      } catch (cause) {
        if (live && mounted.current) setInspectionError(normalizeError(cause).message);
      }
    })();
    return () => { live = false };
  }, [reader, account, chainId, config]);

  // Account/chain changes and any loss of compiled output drop the pending
  // intent; only already-broadcast transaction facts survive (§14, §16).
  useEffect(() => {
    setPhase(current => (keepPhase(current) ? current : IDLE));
    reviewing.current = null;
  }, [account, chainId, output]);

  const review = useCallback(() => {
    if (output === null) return;
    reviewing.current = output.program;
    setPhase({ kind: 'review' });
  }, [output]);

  const send = useCallback(async () => {
    if (output === null || config.kind !== 'configured' || session.signer === null || session.reader === null) {
      setPhase({ kind: 'failed', txHash: null, message: 'Wallet session is no longer ready.' });
      return;
    }
    const expectedProgram = reviewing.current;
    if (expectedProgram !== null && expectedProgram !== output.program) {
      setPhase({ kind: 'failed', txHash: null, message: 'Compiled program changed after review — nothing was sent.' });
      return;
    }
    const intent = { account: session.account, chainId: session.chainId };
    setPhase({ kind: 'awaiting-confirmation' });
    let txHash = '';
    try {
      // Nothing computed before the click is trusted here (§14).
      const [current, network] = await Promise.all([
        session.signer.getAddress(),
        session.signer.provider.getNetwork(),
      ]);
      if (intent.account === null || current.toLowerCase() !== intent.account.toLowerCase()) {
        throw new LisaError('WALLET_DISCONNECTED', 'Connected account changed before sending — nothing was sent.');
      }
      if (normalizeChainId(network.chainId) !== intent.chainId) {
        throw new LisaError('WRONG_CHAIN', 'Connected chain changed before sending — nothing was sent.');
      }
      const status = await inspectLisaAccount(session.reader, current, config);
      if (status.kind !== 'ready') {
        throw new LisaError(
          status.kind === 'runtime-mismatch' ? 'RUNTIME_MISMATCH' : 'UNKNOWN_DELEGATION',
          `Account is no longer a ready LisaAccount (${status.kind}) — nothing was sent.`,
        );
      }
      const transaction = prepareExecuteLisaTransaction({ account: current, program: output.program, status });
      const sent = await session.signer.sendTransaction(transaction);
      txHash = sent.hash ?? '';
      if (!mounted.current) return;
      setPhase({ kind: 'submitted', txHash });
      const receipt = await sent.wait();
      if (!mounted.current) return;
      if (receipt === null) setPhase({ kind: 'failed', txHash, message: 'No receipt received.' });
      else if (receipt.status === 1) setPhase({ kind: 'confirmed', txHash, blockNumber: receipt.blockNumber });
      else if (receipt.status === 0) setPhase({ kind: 'reverted', txHash });
      else setPhase({ kind: 'failed', txHash, message: 'Receipt status is unavailable.' });
    } catch (cause) {
      if (!mounted.current) return;
      const error = normalizeError(cause);
      // No automatic retry, in any branch (§8).
      setPhase(error.code === 'TRANSACTION_REVERTED'
        ? { kind: 'reverted', txHash }
        : { kind: 'failed', txHash: txHash === '' ? null : txHash, message: error.message });
    }
  }, [config, output, session.signer, session.reader, session.account, session.chainId]);

  const alert = gateAlert(gate);
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
      <Box sx={{ ml: 'auto' }}>
        {phase.kind === 'idle' || phase.kind === 'review'
          ? <Button size="small" variant="contained" disabled={!canExecute(gate)} onClick={review}>Execute program</Button>
          : phase.kind === 'awaiting-confirmation'
            // Broadcast-phase facts are labeled once, in the receipt row below.
            ? <Typography variant="body2" color="text.secondary">{describePhase(phase)}</Typography>
            : null}
      </Box>
    </Stack>
    {alert !== null && phase.kind !== 'review' && <Alert severity={alert.severity} sx={{ mt: 1 }} role="status">{alert.text}</Alert>}

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
        <Button size="small" color="primary" variant="contained" onClick={() => void send()}>Confirm and send</Button>
        <Button size="small" onClick={() => { reviewing.current = null; setPhase(IDLE) }}>Cancel</Button>
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
  </Paper>;
}
