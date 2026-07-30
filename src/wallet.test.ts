/**
 * Checks exact human previews and fail-closed batch classification at the wallet boundary.
 */
import type { WalletRequest } from "@aomi-labs/client";
import type { IAgentRuntime } from "@elizaos/core";
import {
	AddressLookupTableAccount,
	Keypair,
	PublicKey,
	SystemProgram,
	Transaction,
	TransactionInstruction,
	TransactionMessage,
	VersionedTransaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { EVM_REQUEST } from "./__tests__/test-helpers.js";
import {
	executeWalletRequest,
	walletRequestPreview,
	walletRequestSupportError,
} from "./wallet.js";
import { WALLET_BACKEND_SERVICE_TYPE } from "./wallet-backend.js";

const TOKEN_PROGRAM_ID = new PublicKey(
	"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

describe("Aomi wallet previews", () => {
	it("shows the exact EVM chain, target, value, and call count", () => {
		const preview = walletRequestPreview(EVM_REQUEST);
		expect(preview).toContain("Chain: 8453");
		expect(preview).toContain(
			"Target: 0x000000000000000000000000000000000000dEaD",
		);
		expect(preview).toContain("Value (wei): 1000");
		expect(preview).toContain("Gas limit: automatic");
		expect(preview).toContain("Calldata: 0x");
		expect(preview).toContain("Calls: 1");
	});

	it("rejects multi-call EVM envelopes before any partial execution", () => {
		const batch: WalletRequest = {
			...EVM_REQUEST,
			payload: {
				...EVM_REQUEST.payload,
				calls: [
					{
						txId: 7,
						chainId: 8453,
						to: "0x0000000000000000000000000000000000000001",
					},
					{
						txId: 8,
						chainId: 8453,
						to: "0x0000000000000000000000000000000000000002",
					},
				],
			},
		};
		expect(walletRequestSupportError(batch)).toContain("Atomic EVM batches");
	});

	it("distinguishes sign-only from sign-and-send Solana requests", () => {
		const signer = Keypair.generate();
		const transaction = new Transaction({
			feePayer: signer.publicKey,
			recentBlockhash: "11111111111111111111111111111111",
		}).add(
			SystemProgram.transfer({
				fromPubkey: signer.publicKey,
				toPubkey: Keypair.generate().publicKey,
				lamports: 1,
			}),
		);
		const sign: WalletRequest = {
			id: "sol-1",
			kind: "solana_sign",
			timestamp: 1,
			payload: {
				unsignedTx: transaction
					.serialize({
						requireAllSignatures: false,
						verifySignatures: false,
					})
					.toString("base64"),
				cluster: "solana:devnet",
				description: "Sign a devnet transaction",
			},
		};
		const submit: WalletRequest = {
			...sign,
			kind: "solana_sign_and_send",
		};
		expect(walletRequestPreview(sign)).toContain("Reply yes to sign,");
		expect(walletRequestPreview(sign)).toContain(
			`Fee payer: ${signer.publicKey.toBase58()}`,
		);
		expect(walletRequestPreview(sign)).toContain("Instructions: 1");
		expect(walletRequestPreview(sign)).toContain(
			`Transfer 1 recipient: ${transaction.instructions[0].keys[1].pubkey.toBase58()}`,
		);
		expect(walletRequestPreview(sign)).toContain(
			"Transfer 1 token: native SOL",
		);
		expect(walletRequestPreview(sign)).toContain(
			"Transfer 1 amount: 1 lamports (0.000000001 SOL)",
		);
		expect(walletRequestPreview(sign)).toContain("sha256:");
		expect(walletRequestPreview(submit)).toContain("sign and submit");
	});

	it("blocks token programs instead of offering opaque signing", () => {
		const signer = Keypair.generate();
		const transaction = new Transaction({
			feePayer: signer.publicKey,
			recentBlockhash: "11111111111111111111111111111111",
		}).add(
			new TransactionInstruction({
				programId: TOKEN_PROGRAM_ID,
				keys: [],
				data: Buffer.from([1, 2, 3]),
			}),
		);
		const request: WalletRequest = {
			id: "sol-opaque",
			kind: "solana_sign_and_send",
			timestamp: 1,
			payload: {
				unsignedTx: transaction
					.serialize({
						requireAllSignatures: false,
						verifySignatures: false,
					})
					.toString("base64"),
				cluster: "solana:devnet",
			},
		};

		expect(walletRequestSupportError(request)).toMatch(
			/Opaque Solana signing is blocked/i,
		);
		expect(() => walletRequestPreview(request)).toThrow(
			/Opaque Solana signing is blocked/i,
		);
	});

	it("rechecks Solana transparency at execution before calling the signer", async () => {
		const signer = Keypair.generate();
		const transaction = new Transaction({
			feePayer: signer.publicKey,
			recentBlockhash: "11111111111111111111111111111111",
		}).add(
			new TransactionInstruction({
				programId: TOKEN_PROGRAM_ID,
				keys: [],
				data: Buffer.from([3]),
			}),
		);
		const request: WalletRequest = {
			id: "sol-execution-opaque",
			kind: "solana_sign",
			timestamp: 1,
			payload: {
				unsignedTx: transaction
					.serialize({
						requireAllSignatures: false,
						verifySignatures: false,
					})
					.toString("base64"),
				cluster: "solana:devnet",
			},
		};
		let signCalls = 0;
		const walletService = {
			getWalletBackend: () => ({
				getAddresses: () => ({ evm: null, solana: signer.publicKey }),
				getEvmAccount: () => {
					throw new Error("EVM is not configured.");
				},
				getSolanaSigner: () => ({
					publicKey: signer.publicKey,
					signTransaction: async (value: Transaction) => {
						signCalls += 1;
						return value;
					},
					signMessage: async (message: Uint8Array) => message,
				}),
			}),
			getWalletBackendOrNull: () => null,
		};
		const runtime = {
			getService: (serviceType: string) =>
				serviceType === WALLET_BACKEND_SERVICE_TYPE ? walletService : null,
			getSetting: () => undefined,
		} as unknown as IAgentRuntime;

		await expect(
			executeWalletRequest(
				runtime,
				{
					apiUrl: "https://api.aomi.dev",
					app: "default",
					chainId: 8453,
				},
				request,
			),
		).rejects.toMatchObject({ code: "AOMI_OPAQUE_SOLANA_TRANSACTION" });
		expect(signCalls).toBe(0);
	});

	it("blocks versioned transactions whose accounts require lookup tables", () => {
		const signer = Keypair.generate();
		const recipient = Keypair.generate().publicKey;
		const lookupTable = new AddressLookupTableAccount({
			key: Keypair.generate().publicKey,
			state: {
				deactivationSlot: 18_446_744_073_709_551_615n,
				lastExtendedSlot: 0,
				lastExtendedSlotStartIndex: 0,
				authority: undefined,
				addresses: [recipient],
			},
		});
		const message = new TransactionMessage({
			payerKey: signer.publicKey,
			recentBlockhash: "11111111111111111111111111111111",
			instructions: [
				SystemProgram.transfer({
					fromPubkey: signer.publicKey,
					toPubkey: recipient,
					lamports: 1,
				}),
			],
		}).compileToV0Message([lookupTable]);
		const request: WalletRequest = {
			id: "sol-lookup-table",
			kind: "solana_sign_and_send",
			timestamp: 1,
			payload: {
				unsignedTx: Buffer.from(
					new VersionedTransaction(message).serialize(),
				).toString("base64"),
				cluster: "solana:devnet",
			},
		};

		expect(walletRequestSupportError(request)).toMatch(
			/address lookup tables/i,
		);
	});

	it("shows readable Solana messages and blocks opaque message bytes", () => {
		const readable: WalletRequest = {
			id: "sol-message-readable",
			kind: "solana_sign_message",
			timestamp: 1,
			payload: {
				message: Buffer.from("Sign in to Aomi testnet").toString("base64"),
				cluster: "solana:devnet",
			},
		};
		const opaque: WalletRequest = {
			...readable,
			id: "sol-message-opaque",
			payload: {
				...readable.payload,
				message: Buffer.from([0xff, 0x00, 0x81]).toString("base64"),
			},
		};

		expect(walletRequestPreview(readable)).toContain(
			'Message (UTF-8): "Sign in to Aomi testnet"',
		);
		expect(walletRequestSupportError(readable)).toBeNull();
		expect(walletRequestSupportError(opaque)).toMatch(
			/Opaque message signing is blocked/i,
		);
	});

	it("blocks bidi-control message spoofing but allows tabs", () => {
		// U+202E RIGHT-TO-LEFT OVERRIDE, built by code point so the source stays
		// free of an invisible bidi control character.
		const spoofed = `Send 1 SOL to ${String.fromCodePoint(0x202e)}reterp`;
		const bidi: WalletRequest = {
			id: "sol-bidi",
			kind: "solana_sign_message",
			timestamp: 1,
			payload: {
				message: Buffer.from(spoofed, "utf8").toString("base64"),
				cluster: "solana:devnet",
			},
		};
		expect(walletRequestSupportError(bidi)).toMatch(
			/Opaque message signing is blocked/i,
		);
		const tabbed: WalletRequest = {
			...bidi,
			id: "sol-tab",
			payload: {
				...bidi.payload,
				message: Buffer.from("Amount:\t1 SOL", "utf8").toString("base64"),
			},
		};
		expect(walletRequestSupportError(tabbed)).toBeNull();
		expect(walletRequestPreview(tabbed)).toContain("Amount:");
	});

	it("rejects a foreign-owned Solana transfer before confirmation", () => {
		const wallet = Keypair.generate();
		const foreign = Keypair.generate();
		const transaction = new Transaction({
			feePayer: foreign.publicKey,
			recentBlockhash: "11111111111111111111111111111111",
		}).add(
			SystemProgram.transfer({
				fromPubkey: foreign.publicKey,
				toPubkey: Keypair.generate().publicKey,
				lamports: 1,
			}),
		);
		const request: WalletRequest = {
			id: "sol-foreign",
			kind: "solana_sign",
			timestamp: 1,
			payload: {
				unsignedTx: transaction
					.serialize({ requireAllSignatures: false, verifySignatures: false })
					.toString("base64"),
				cluster: "solana:devnet",
			},
		};
		expect(
			walletRequestSupportError(request, {
				evm: null,
				solana: wallet.publicKey.toBase58(),
			}),
		).toMatch(/not fully owned/i);
		expect(
			walletRequestSupportError(request, {
				evm: null,
				solana: foreign.publicKey.toBase58(),
			}),
		).toBeNull();
	});

	it("refuses to sign a Solana transaction with a second required signer", async () => {
		const wallet = Keypair.generate();
		const other = Keypair.generate();
		const transaction = new Transaction({
			feePayer: wallet.publicKey,
			recentBlockhash: "11111111111111111111111111111111",
		})
			.add(
				SystemProgram.transfer({
					fromPubkey: wallet.publicKey,
					toPubkey: Keypair.generate().publicKey,
					lamports: 1,
				}),
			)
			.add(
				SystemProgram.transfer({
					fromPubkey: other.publicKey,
					toPubkey: Keypair.generate().publicKey,
					lamports: 1,
				}),
			);
		const request: WalletRequest = {
			id: "sol-multisig",
			kind: "solana_sign",
			timestamp: 1,
			payload: {
				unsignedTx: transaction
					.serialize({ requireAllSignatures: false, verifySignatures: false })
					.toString("base64"),
				cluster: "solana:devnet",
			},
		};
		let signCalls = 0;
		const walletService = {
			getWalletBackend: () => ({
				getAddresses: () => ({ evm: null, solana: wallet.publicKey }),
				getEvmAccount: () => {
					throw new Error("EVM is not configured.");
				},
				getSolanaSigner: () => ({
					publicKey: wallet.publicKey,
					signTransaction: async (value: Transaction) => {
						signCalls += 1;
						return value;
					},
					signMessage: async (message: Uint8Array) => message,
				}),
			}),
			getWalletBackendOrNull: () => null,
		};
		const runtime = {
			getService: (serviceType: string) =>
				serviceType === WALLET_BACKEND_SERVICE_TYPE ? walletService : null,
			getSetting: () => undefined,
		} as unknown as IAgentRuntime;

		await expect(
			executeWalletRequest(
				runtime,
				{ apiUrl: "https://api.aomi.dev", app: "default", chainId: 8453 },
				request,
			),
		).rejects.toMatchObject({ code: "AOMI_SOLANA_SIGNER_MISMATCH" });
		expect(signCalls).toBe(0);
	});

	it("rejects malformed base64 before a Solana confirmation can be shown", () => {
		const request: WalletRequest = {
			id: "sol-invalid",
			kind: "solana_sign",
			timestamp: 1,
			payload: { unsignedTx: "not base64 !!!" },
		};
		expect(() => walletRequestPreview(request)).toThrow(/valid base64/i);
	});

	it("shows the exact EIP-712 domain and message before signing", () => {
		const request: WalletRequest = {
			id: "eip712-1",
			kind: "eip712_sign",
			timestamp: 1,
			payload: {
				typed_data: {
					domain: { name: "Permit", chainId: 8453 },
					primaryType: "Permit",
					message: { spender: "0x000000000000000000000000000000000000dEaD" },
				},
			},
		};
		const preview = walletRequestPreview(request);
		expect(preview).toContain('"name":"Permit"');
		expect(preview).toContain(
			'"spender":"0x000000000000000000000000000000000000dEaD"',
		);
	});
});
