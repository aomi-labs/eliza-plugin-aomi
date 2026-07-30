/**
 * Opt-in public-devnet execution evidence for the Solana wallet boundary.
 *
 * The test creates an ephemeral signer in memory, funds it from the devnet
 * faucet, submits one decoded native SOL transfer through executeWalletRequest,
 * verifies balances, and exercises a real insufficient-funds failure.
 */
import type { WalletRequest } from "@aomi-labs/client";
import type { IAgentRuntime } from "@elizaos/core";
import {
	Connection,
	Keypair,
	SystemProgram,
	Transaction,
	type VersionedTransaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { executeWalletRequest, walletRequestPreview } from "./wallet.js";
import {
	WALLET_BACKEND_SERVICE_TYPE,
	type WalletBackendLike,
} from "./wallet-backend.js";

const live = process.env.ELIZA_E2E_AOMI_SOLANA_WALLET === "1";
const DEFAULT_DEVNET_RPC = "https://api.devnet.solana.com";
const TRANSFER_LAMPORTS = 1_000_000;

function evidenceKeypair(): Keypair {
	const encoded = process.env.SOLANA_PRIVATE_KEY?.trim();
	if (!encoded) return Keypair.generate();
	const parsed = JSON.parse(encoded);
	if (
		!Array.isArray(parsed) ||
		parsed.length !== 64 ||
		parsed.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
	) {
		throw new Error(
			"SOLANA_PRIVATE_KEY must be a JSON array containing 64 bytes.",
		);
	}
	return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

function runtimeWithKeypair(keypair: Keypair): IAgentRuntime {
	const backend: WalletBackendLike = {
		getAddresses: () => ({ evm: null, solana: keypair.publicKey }),
		getEvmAccount: () => {
			throw new Error("EVM is not configured for the Solana live test.");
		},
		getSolanaSigner: () => ({
			publicKey: keypair.publicKey,
			signTransaction: async (
				transaction: Transaction | VersionedTransaction,
			) => {
				if (transaction instanceof Transaction) {
					transaction.partialSign(keypair);
				} else {
					transaction.sign([keypair]);
				}
				return transaction;
			},
			signMessage: async (message: Uint8Array) =>
				Uint8Array.from(
					await crypto.subtle
						.digest("SHA-512", message)
						.then((digest) => new Uint8Array(digest).slice(0, 64)),
				),
		}),
	};
	const walletService = {
		getWalletBackend: () => backend,
		getWalletBackendOrNull: () => backend,
	};
	return {
		getSetting: (key: string) =>
			key === "SOLANA_RPC_URL"
				? (process.env.SOLANA_RPC_URL ?? DEFAULT_DEVNET_RPC)
				: key === "SOLANA_CLUSTER"
					? "solana:devnet"
					: undefined,
		getService: (serviceType: string) =>
			serviceType === WALLET_BACKEND_SERVICE_TYPE ? walletService : null,
	} as unknown as IAgentRuntime;
}

async function transferRequest(
	connection: Connection,
	sender: Keypair,
	recipient: Keypair,
	id: string,
): Promise<WalletRequest> {
	const { blockhash } = await connection.getLatestBlockhash("confirmed");
	const transaction = new Transaction({
		feePayer: sender.publicKey,
		recentBlockhash: blockhash,
	}).add(
		SystemProgram.transfer({
			fromPubkey: sender.publicKey,
			toPubkey: recipient.publicKey,
			lamports: TRANSFER_LAMPORTS,
		}),
	);
	return {
		id,
		kind: "solana_sign_and_send",
		timestamp: Date.now(),
		payload: {
			unsignedTx: transaction
				.serialize({
					requireAllSignatures: false,
					verifySignatures: false,
				})
				.toString("base64"),
			cluster: "solana:devnet",
			description: "Aomi plugin public devnet execution evidence",
		},
	};
}

describe.runIf(live)("Aomi Solana public-devnet execution", () => {
	it("submits one decoded transfer and proves a real insufficient-funds failure", async () => {
		const rpcUrl = process.env.SOLANA_RPC_URL ?? DEFAULT_DEVNET_RPC;
		const connection = new Connection(rpcUrl, "confirmed");
		const sender = evidenceKeypair();
		const recipient = Keypair.generate();

		let airdropSignature: string | null = null;
		const initialBalance = await connection.getBalance(
			sender.publicKey,
			"confirmed",
		);
		if (initialBalance < 10_000_000) {
			airdropSignature = await connection.requestAirdrop(
				sender.publicKey,
				10_000_000 - initialBalance,
			);
			const airdropConfirmation = await connection.confirmTransaction(
				airdropSignature,
				"confirmed",
			);
			expect(airdropConfirmation.value.err).toBeNull();
		}

		const senderBefore = await connection.getBalance(
			sender.publicKey,
			"confirmed",
		);
		const recipientBefore = await connection.getBalance(
			recipient.publicKey,
			"confirmed",
		);
		const request = await transferRequest(
			connection,
			sender,
			recipient,
			"aomi-solana-devnet-send",
		);
		const preview = walletRequestPreview(request);
		const result = await executeWalletRequest(
			runtimeWithKeypair(sender),
			{
				apiUrl: "https://api.aomi.dev",
				app: "default",
				chainId: 8453,
			},
			request,
		);
		expect(result.kind).toBe("solana_sign_and_send");
		if (result.kind !== "solana_sign_and_send") return;

		const senderAfter = await connection.getBalance(
			sender.publicKey,
			"confirmed",
		);
		const recipientAfter = await connection.getBalance(
			recipient.publicKey,
			"confirmed",
		);
		expect(recipientAfter - recipientBefore).toBe(TRANSFER_LAMPORTS);
		expect(senderAfter).toBeLessThan(senderBefore);

		const emptySigner = Keypair.generate();
		expect(
			await connection.getBalance(emptySigner.publicKey, "confirmed"),
		).toBe(0);
		const failingRequest = await transferRequest(
			connection,
			emptySigner,
			recipient,
			"aomi-solana-devnet-insufficient",
		);
		let failureMessage = "";
		try {
			await executeWalletRequest(
				runtimeWithKeypair(emptySigner),
				{
					apiUrl: "https://api.aomi.dev",
					app: "default",
					chainId: 8453,
				},
				failingRequest,
			);
		} catch (error) {
			failureMessage = error instanceof Error ? error.message : String(error);
		}
		expect(failureMessage).toMatch(/insufficient|no prior credit|account/i);

		console.info(
			JSON.stringify({
				network: {
					cluster: "devnet",
					rpcOrigin: new URL(rpcUrl).origin,
				},
				airdropSignature,
				transaction: {
					signature: result.signature,
					explorer: `https://explorer.solana.com/tx/${result.signature}?cluster=devnet`,
					preview,
				},
				balances: {
					sender: {
						address: sender.publicKey.toBase58(),
						beforeLamports: senderBefore,
						afterLamports: senderAfter,
					},
					recipient: {
						address: recipient.publicKey.toBase58(),
						beforeLamports: recipientBefore,
						afterLamports: recipientAfter,
					},
				},
				failurePath: {
					kind: "insufficient-funds",
					address: emptySigner.publicKey.toBase58(),
					balanceLamports: 0,
					message: failureMessage,
				},
			}),
		);
	}, 120_000);
});
