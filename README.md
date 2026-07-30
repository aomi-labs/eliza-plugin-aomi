# @aomi-labs/eliza-plugin-aomi

Delegates natural-language on-chain workflows from an Eliza agent to Aomi
without moving wallet custody or transaction approval outside elizaOS.

## Capabilities

- Sends open-ended research, simulation, DeFi, and transaction requests to
  Aomi.
- Keeps one Aomi thread per Eliza room so follow-up requests retain context.
- Connects the configured `@elizaos/plugin-wallet` EVM and Solana addresses to
  Aomi.
- Stops every wallet request at an exact transaction or signature preview.
- Requires a separate confirmation turn from the same user who initiated the
  operation.
- Single-flights concurrent confirmations so one wallet request can execute at
  most once.
- Supports single-call EVM transactions, EIP-712 and message signatures, and
  decoded native SOL transfers.
- Blocks opaque Solana transactions, address lookup tables, token/unknown
  programs, non-wallet transfer sources, and non-displayable signed messages.

## Install

```bash
bun add @aomi-labs/eliza-plugin-aomi @elizaos/plugin-wallet
```

Add both plugins to the character:

```ts
plugins: ["@elizaos/plugin-wallet", "@aomi-labs/eliza-plugin-aomi"];
```

Configure at least one wallet signing path supported by
`@elizaos/plugin-wallet`. No Aomi credential is required for the public
`default` app.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AOMI_API_URL` | `https://api.aomi.dev` | Aomi backend base URL |
| `AOMI_API_KEY` | unset | Private Aomi app API key |
| `AOMI_APP` | `default` | Aomi app key |
| `AOMI_APPLICATION_ID` | unset | Concrete Aomi application id |
| `AOMI_CHAIN_ID` | `1` | Default EVM chain id |
| `AOMI_EVM_RPC_URL` | chain default | RPC override for Aomi-built EVM transactions |

Wallet variables such as `EVM_PRIVATE_KEY`, `SOLANA_PRIVATE_KEY`, and
`SOLANA_RPC_URL` are owned by `@elizaos/plugin-wallet`.

## Confirmation flow

1. The user asks the agent to use Aomi for an on-chain task.
2. Read-only tasks return immediately.
3. When Aomi requests a wallet operation, the plugin displays the exact target,
   chain, value, call count, signature payload, or decoded native SOL recipient
   and amount.
4. The initiating user replies `yes` to execute or anything else to reject.
5. The plugin signs through `WalletBackendService`, submits when required, and
   resumes the same Aomi thread with the result.

The initiating prompt never authorizes a write. LLM-supplied confirmation flags
are ignored; confirmation state is held by the elizaOS runtime and bound to the
initiating `entityId`. Concurrent confirmation delivery shares one in-flight
wallet execution and one Aomi settlement.

## Solana safety policy

The initial release intentionally supports only fully decoded native SOL
`SystemProgram.transfer` instructions. The confirmation preview names every
source, recipient, amount in lamports and SOL, fee payer, instruction count,
program, byte length, and payload hash.

The plugin rejects the request before confirmation if it contains an address
lookup table, SPL token instruction, unknown program, non-transfer System
instruction, missing payload, non-wallet fee payer/source, or opaque signed
message. Expanding this allowlist requires a decoder and tests that surface the
exact token, recipient, amount, and writable accounts.

## Development

```bash
bun install
bun run typecheck
bun run lint:check
bun run test
bun run build
```

Set `ELIZA_E2E_AOMI=1` to run the live Aomi contract test.

For the opt-in wallet E2E, point `AOMI_EVM_RPC_URL` and `AOMI_CHAIN_ID` at a
supported testnet or chain `31337` fork, provide a funded `EVM_PRIVATE_KEY`, and
run `bun run test:wallet-live`. The test refuses production chain ids, records
the transaction hash and balance change, and verifies a real insufficient-funds
failure with a fresh empty signer.

`bun run test:wallet-solana-live` creates an ephemeral in-memory Solana signer,
funds it from the public devnet faucet, submits one decoded one-lamport transfer,
and records the explorer link, preview, balance delta, and a real
insufficient-funds failure. No signing key is written to disk.

## Registry

`registry-entry.json` contains the tiny third-party entry for the elizaOS
registry. The plugin source and release lifecycle live entirely in this
repository.

## Releasing

Publishing is driven by the `version` field in `package.json`. To cut a release,
bump that version in a pull request. When the PR merges to `main`, the publish
workflow validates the package and, if the version is not already on npm,
publishes it and pushes a matching `v<version>` git tag. Merges that do not
change the version are no-ops for npm, so an unrelated merge never triggers a
publish. A published GitHub Release and manual `workflow_dispatch` remain
supported as alternative triggers.
