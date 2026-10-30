import { AbiCoder, keccak256, toUtf8Bytes } from 'ethers';
import type { SafeTx } from '../wallet/safe';

/**
 * Test-only: the Safe's transaction digest written straight from the contract
 * source (`GnosisSafe.sol` 1.3.0 / `Safe.sol` 1.4.1) instead of through the
 * module under test. Tests compare the app's digest to this one, so a wrong
 * field order or a wrong domain shape cannot pass by agreeing with itself.
 *
 *   domainSeparator() = keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, chainId, this))
 *   safeTxHash        = keccak256(abi.encode(SAFE_TX_TYPEHASH, to, value,
 *                                             keccak256(data), operation, safeTxGas,
 *                                             baseGas, gasPrice, gasToken,
 *                                             refundReceiver, nonce))
 *   digest            = keccak256(abi.encodePacked(0x19, 0x01, domainSeparator, safeTxHash))
 */

/** `keccak256("EIP712Domain(uint256 chainId,address verifyingContract)")` */
export const DOMAIN_SEPARATOR_TYPEHASH = keccak256(toUtf8Bytes('EIP712Domain(uint256 chainId,address verifyingContract)'));

/** `keccak256("SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)")` */
export const SAFE_TX_TYPEHASH = keccak256(toUtf8Bytes(
  'SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)',
));

const abi = AbiCoder.defaultAbiCoder();

export function referenceSafeTransactionHash(chainId: string, safe: string, transaction: SafeTx): string {
  const domainSeparator = keccak256(abi.encode(
    ['bytes32', 'uint256', 'address'],
    [DOMAIN_SEPARATOR_TYPEHASH, BigInt(chainId), safe],
  ));
  const safeTxHash = keccak256(abi.encode(
    ['bytes32', 'address', 'uint256', 'bytes32', 'uint8', 'uint256', 'uint256', 'uint256', 'address', 'address', 'uint256'],
    [
      SAFE_TX_TYPEHASH, transaction.to, transaction.value, keccak256(transaction.data),
      transaction.operation, transaction.safeTxGas, transaction.baseGas, transaction.gasPrice,
      transaction.gasToken, transaction.refundReceiver, transaction.nonce,
    ],
  ));
  return keccak256(`0x1901${domainSeparator.slice(2)}${safeTxHash.slice(2)}`);
}
