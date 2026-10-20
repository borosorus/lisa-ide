import type { ContractFunction, ContractResource, GraphEdge, GraphNode, VisualProject } from './model';

export interface VisualExample {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Fresh project data so loading an example never mutates the catalog. */
  createProject(): VisualProject;
}

const TOKEN = '0x1111111111111111111111111111111111111111';
const VAULT = '0x2222222222222222222222222222222222222222';
const RECIPIENT = '0x3333333333333333333333333333333333333333';

const BALANCE_OF: ContractFunction = {
  signature: 'balanceOf(address)', name: 'balanceOf', inputs: ['address'], outputs: ['uint256'], mutability: 'view',
};
const TRANSFER: ContractFunction = {
  signature: 'transfer(address,uint256)', name: 'transfer', inputs: ['address', 'uint256'], outputs: ['bool'], mutability: 'nonpayable',
};
const TOKEN_RESOURCE: ContractResource = { id: 'c1', name: 'TOKEN', address: TOKEN, functions: [BALANCE_OF, TRANSFER] };
const VAULT_RESOURCE: ContractResource = {
  id: 'c2', name: 'VAULT', address: VAULT, functions: [
    { signature: 'recordPayout(address,uint256)', name: 'recordPayout', inputs: ['address', 'uint256'], outputs: [], mutability: 'nonpayable' },
    { signature: 'queuePayout(address,uint256)', name: 'queuePayout', inputs: ['address', 'uint256'], outputs: [], mutability: 'nonpayable' },
  ],
};

function project(
  contracts: readonly ContractResource[],
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  positions: VisualProject['positions'],
  frameSizes: VisualProject['frameSizes'] = {},
): VisualProject {
  return {
    contracts: contracts.map(contract => ({ ...contract, functions: contract.functions.map(fn => ({
      ...fn,
      inputs: [...fn.inputs],
      outputs: [...fn.outputs],
      ...(fn.inputNames ? { inputNames: [...fn.inputNames] } : {}),
      ...(fn.outputNames ? { outputNames: [...fn.outputNames] } : {}),
    })) })),
    nodes: nodes.map(node => ({ ...node })),
    edges: edges.map(edge => ({ ...edge, from: { ...edge.from }, to: { ...edge.to } })),
    positions: { ...positions },
    frameSizes: { ...frameSizes },
  };
}

/** Canvas-first walkthroughs, intentionally separate from source code examples. */
export const VISUAL_EXAMPLES: readonly VisualExample[] = [
  {
    id: 'token-balance-transfer',
    label: 'Transfer tokens after a balance check',
    description: 'Reads the executor’s token balance, then transfers a fixed amount to the caller when it is sufficient. Replace the token address and amount.',
    createProject: () => project([TOKEN_RESOURCE], [
      { id: 'self1', kind: 'context', name: 'SELF' },
      { id: 'caller1', kind: 'context', name: 'CALLER' },
      { id: 'amount1', kind: 'literal', literalType: 'uint', literal: '1000000' },
      { id: 'balance1', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)' },
      { id: 'minimum1', kind: 'literal', literalType: 'uint', literal: '999999' },
      { id: 'enough1', kind: 'binary', op: 'gt' },
      { id: 'if1', kind: 'if' },
      { id: 'else1', kind: 'else' },
      { id: 'transfer1', kind: 'call', contractId: 'c1', signature: 'transfer(address,uint256)', parent: 'if1' },
    ], [
      { id: 'e1', from: { node: 'self1', port: 'out' }, to: { node: 'balance1', port: 'arg:0' } },
      { id: 'e2', from: { node: 'balance1', port: 'out:0' }, to: { node: 'enough1', port: 'lhs' } },
      { id: 'e3', from: { node: 'minimum1', port: 'out' }, to: { node: 'enough1', port: 'rhs' } },
      { id: 'e4', from: { node: 'enough1', port: 'out' }, to: { node: 'if1', port: 'condition' } },
      { id: 'e5', from: { node: 'caller1', port: 'out' }, to: { node: 'transfer1', port: 'arg:0' } },
      { id: 'e6', from: { node: 'amount1', port: 'out' }, to: { node: 'transfer1', port: 'arg:1' } },
      { id: 'e7', kind: 'control', from: { node: 'if1', port: 'else' }, to: { node: 'else1', port: 'if' } },
    ], {
      self1: { x: 40, y: 120 }, balance1: { x: 260, y: 100 }, amount1: { x: 40, y: 300 },
      minimum1: { x: 260, y: 330 }, enough1: { x: 540, y: 180 }, if1: { x: 780, y: 100 },
      caller1: { x: 700, y: 450 }, transfer1: { x: 820, y: 220 }, else1: { x: 1296, y: 100 },
    }, { if1: { width: 460, height: 350 }, else1: { width: 420, height: 350 } }),
  },
  {
    id: 'try-transfer-fallback',
    label: 'Try a token payout with a fallback',
    description: 'Checks the try-call success flag and the token’s returned bool; records accepted payouts and queues failed ones.',
    createProject: () => project([TOKEN_RESOURCE, VAULT_RESOURCE], [
      { id: 'caller1', kind: 'context', name: 'CALLER' },
      { id: 'amount1', kind: 'literal', literalType: 'uint', literal: '1000000' },
      { id: 'transfer1', kind: 'call', contractId: 'c1', signature: 'transfer(address,uint256)', failureMode: 'continue' },
      { id: 'success1', kind: 'if' },
      { id: 'successElse', kind: 'else' },
      { id: 'returned1', kind: 'literal', literalType: 'uint', literal: '1', parent: 'success1' },
      { id: 'accepted1', kind: 'binary', op: 'eq', parent: 'success1' },
      { id: 'acceptedIf', kind: 'if', parent: 'success1' },
      { id: 'acceptedElse', kind: 'else', parent: 'success1' },
      { id: 'record1', kind: 'call', contractId: 'c2', signature: 'recordPayout(address,uint256)', parent: 'acceptedIf' },
      { id: 'queueFalse', kind: 'call', contractId: 'c2', signature: 'queuePayout(address,uint256)', parent: 'acceptedElse' },
      { id: 'queueRevert', kind: 'call', contractId: 'c2', signature: 'queuePayout(address,uint256)', parent: 'successElse' },
    ], [
      { id: 'e1', from: { node: 'caller1', port: 'out' }, to: { node: 'transfer1', port: 'arg:0' } },
      { id: 'e2', from: { node: 'amount1', port: 'out' }, to: { node: 'transfer1', port: 'arg:1' } },
      { id: 'e3', from: { node: 'transfer1', port: 'success' }, to: { node: 'success1', port: 'condition' } },
      { id: 'e4', from: { node: 'transfer1', port: 'out:0' }, to: { node: 'accepted1', port: 'lhs' } },
      { id: 'e5', from: { node: 'returned1', port: 'out' }, to: { node: 'accepted1', port: 'rhs' } },
      { id: 'e6', from: { node: 'accepted1', port: 'out' }, to: { node: 'acceptedIf', port: 'condition' } },
      { id: 'e7', from: { node: 'caller1', port: 'out' }, to: { node: 'record1', port: 'arg:0' } },
      { id: 'e8', from: { node: 'amount1', port: 'out' }, to: { node: 'record1', port: 'arg:1' } },
      { id: 'e9', from: { node: 'caller1', port: 'out' }, to: { node: 'queueFalse', port: 'arg:0' } },
      { id: 'e10', from: { node: 'amount1', port: 'out' }, to: { node: 'queueFalse', port: 'arg:1' } },
      { id: 'e11', from: { node: 'caller1', port: 'out' }, to: { node: 'queueRevert', port: 'arg:0' } },
      { id: 'e12', from: { node: 'amount1', port: 'out' }, to: { node: 'queueRevert', port: 'arg:1' } },
      { id: 'e13', kind: 'control', from: { node: 'success1', port: 'else' }, to: { node: 'successElse', port: 'if' } },
      { id: 'e14', kind: 'control', from: { node: 'acceptedIf', port: 'else' }, to: { node: 'acceptedElse', port: 'if' } },
    ], {
      caller1: { x: 40, y: 100 }, amount1: { x: 40, y: 280 }, transfer1: { x: 270, y: 150 },
      success1: { x: 560, y: 80 }, successElse: { x: 1616, y: 80 },
      returned1: { x: 590, y: 200 }, accepted1: { x: 790, y: 200 },
      acceptedIf: { x: 590, y: 330 }, acceptedElse: { x: 1080, y: 330 },
      record1: { x: 620, y: 470 }, queueFalse: { x: 1110, y: 470 }, queueRevert: { x: 1640, y: 200 },
    }, { success1: { width: 1000, height: 650 }, successElse: { width: 500, height: 400 },
      acceptedIf: { width: 420, height: 280 }, acceptedElse: { width: 420, height: 280 } }),
  },
  {
    id: 'native-send-guards',
    label: 'Send native currency with guards',
    description: 'Checks the executor’s ETH balance and a deadline before sending a configured amount to a recipient.',
    createProject: () => project([], [
      { id: 'self1', kind: 'context', name: 'SELF' },
      { id: 'balance1', kind: 'balance' },
      { id: 'amount1', kind: 'literal', literalType: 'uint', literal: '1000000000000000' },
      { id: 'enough1', kind: 'binary', op: 'gt' },
      { id: 'guardBalance', kind: 'guard' },
      { id: 'time1', kind: 'context', name: 'TIMESTAMP' },
      { id: 'deadline1', kind: 'literal', literalType: 'uint', literal: '1900000000' },
      { id: 'beforeDeadline', kind: 'binary', op: 'lt' },
      { id: 'guardTime', kind: 'guard' },
      { id: 'recipient1', kind: 'literal', literalType: 'address', literal: RECIPIENT },
      { id: 'sendAmount', kind: 'literal', literalType: 'uint', literal: '1000000000000000' },
      { id: 'send1', kind: 'send' },
    ], [
      { id: 'e1', from: { node: 'self1', port: 'out' }, to: { node: 'balance1', port: 'address' } },
      { id: 'e2', from: { node: 'balance1', port: 'out' }, to: { node: 'enough1', port: 'lhs' } },
      { id: 'e3', from: { node: 'amount1', port: 'out' }, to: { node: 'enough1', port: 'rhs' } },
      { id: 'e4', from: { node: 'enough1', port: 'out' }, to: { node: 'guardBalance', port: 'condition' } },
      { id: 'e5', from: { node: 'time1', port: 'out' }, to: { node: 'beforeDeadline', port: 'lhs' } },
      { id: 'e6', from: { node: 'deadline1', port: 'out' }, to: { node: 'beforeDeadline', port: 'rhs' } },
      { id: 'e7', from: { node: 'beforeDeadline', port: 'out' }, to: { node: 'guardTime', port: 'condition' } },
      { id: 'e8', from: { node: 'recipient1', port: 'out' }, to: { node: 'send1', port: 'address' } },
      { id: 'e9', from: { node: 'sendAmount', port: 'out' }, to: { node: 'send1', port: 'value' } },
    ], {
      self1: { x: 40, y: 100 }, balance1: { x: 300, y: 100 }, amount1: { x: 300, y: 260 },
      enough1: { x: 600, y: 170 }, guardBalance: { x: 820, y: 170 }, time1: { x: 40, y: 430 },
      deadline1: { x: 300, y: 430 }, beforeDeadline: { x: 600, y: 430 }, guardTime: { x: 820, y: 430 },
      recipient1: { x: 1120, y: 120 }, sendAmount: { x: 1120, y: 300 }, send1: { x: 1420, y: 180 },
    }),
  },
  {
    id: 'hash-claim',
    label: 'Claim using a hashed commitment',
    description: 'Hashes a configured commitment and sends it to the claim contract. Replace the target contract and commitment.',
    createProject: () => project([{
      id: 'c1', name: 'CLAIM', address: VAULT, functions: [
        { signature: 'claim(bytes32)', name: 'claim', inputs: ['bytes32'], outputs: [], mutability: 'nonpayable' },
      ],
    }], [
      { id: 'commitment1', kind: 'keccak', data: '0x4c4953412d636c61696d2d303031' },
      { id: 'claim1', kind: 'call', contractId: 'c1', signature: 'claim(bytes32)' },
    ], [
      { id: 'e1', from: { node: 'commitment1', port: 'out' }, to: { node: 'claim1', port: 'arg:0' } },
    ], { commitment1: { x: 260, y: 180 }, claim1: { x: 520, y: 180 } }),
  },
  {
    id: 'raw-token-transfer',
    label: 'Call a token with raw calldata',
    description: 'Sends pre-encoded ERC-20 transfer(address,uint256) data. Replace the token address and calldata to change the recipient or amount.',
    createProject: () => project([], [
      { id: 'token1', kind: 'literal', literalType: 'address', literal: TOKEN },
      { id: 'transfer1', kind: 'rawcall', calldata: '0xa9059cbb0000000000000000000000003333333333333333333333333333333333333333000000000000000000000000000000000000000000000000000000000000002a' },
    ], [
      { id: 'e1', from: { node: 'token1', port: 'out' }, to: { node: 'transfer1', port: 'address' } },
    ], { token1: { x: 260, y: 150 }, transfer1: { x: 520, y: 150 } }),
  },
];
