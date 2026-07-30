/**
 * Structural boundary to the wallet plugin.
 *
 * Keeping this interface local prevents package installation from eagerly
 * resolving the wallet plugin's large optional peer graph. At runtime the
 * object is provided by @elizaos/plugin-wallet under the stable
 * "wallet-backend" service type.
 */
import type {
	PublicKey,
	Transaction,
	VersionedTransaction,
} from "@solana/web3.js";
import type { Account } from "viem";

export const WALLET_BACKEND_SERVICE_TYPE = "wallet-backend" as const;

export interface SolanaSignerLike {
	readonly publicKey: PublicKey;
	signTransaction(
		transaction: Transaction | VersionedTransaction,
	): Promise<Transaction | VersionedTransaction>;
	signMessage(message: Uint8Array): Promise<Uint8Array>;
}

export interface WalletBackendLike {
	getAddresses(): {
		readonly evm: `0x${string}` | null;
		readonly solana: PublicKey | null;
	};
	getEvmAccount(chainId: number): Account;
	getSolanaSigner(): SolanaSignerLike;
}

export interface WalletBackendServiceLike {
	getWalletBackend(): WalletBackendLike;
	getWalletBackendOrNull(): WalletBackendLike | null;
}
