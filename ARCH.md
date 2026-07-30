# Architecture

`@aomi-labs/eliza-plugin-aomi` connects an elizaOS agent to Aomi while
elizaOS retains wallet custody, transaction validation, and final approval.

The simplest mental model is:

- **elizaOS** is the conversational agent runtime.
- **Aomi** researches and plans on-chain work.
- **`@elizaos/plugin-wallet`** owns wallet access and signing.
- **This plugin** coordinates those systems and enforces the confirmation
  boundary.

## System overview

```mermaid
flowchart LR
    U["User"] --> E["elizaOS agent runtime"]

    subgraph EP["elizaOS plugins"]
        AP["Aomi plugin"]
        WP["Wallet plugin"]
    end

    E --> AP
    AP --> A["Aomi API"]
    A --> AP

    AP -->|"Approved wallet request"| WP
    WP -->|"Sign or submit"| B["Blockchain"]

    B --> WP
    WP --> AP
    AP --> A
    AP --> E
    E --> U
```

Aomi never receives the private key. It may propose a wallet operation, but it
cannot approve or sign that operation. The initiating user approves an exact
preview, and the configured wallet plugin performs the signing.

## elizaOS plugin surface

An elizaOS character installs both plugins:

```ts
plugins: [
  "@elizaos/plugin-wallet",
  "@aomi-labs/eliza-plugin-aomi",
];
```

The Aomi plugin registers an action, provider, and service:

```mermaid
flowchart TB
    P["Aomi plugin"]

    P --> AC["Action"]
    P --> PR["Provider"]
    P --> SV["Service"]

    AC --> AC1["Handles Aomi requests"]
    AC --> AC2["Handles confirmation or rejection"]

    PR --> PR1["Adds Aomi and wallet context"]
    PR --> PR2["Exposes a bounded pending preview"]

    SV --> SV1["Maintains one Aomi thread per room"]
    SV --> SV2["Stores pending wallet requests"]
    SV --> SV3["Enforces ownership and single execution"]
```

### Action

`AOMI` is the only action. It handles:

1. A new request such as “use Aomi to inspect my idle assets.”
2. A later confirmation or rejection of a pending wallet operation.

Explicit Aomi requests are routed directly to this action. A separate
confirmation action is intentionally not used.

### Provider

`aomiProvider` supplies the model with bounded operational context:

- Aomi configuration and availability.
- Connected EVM and Solana addresses.
- A safe preview of any pending operation.

It does not expose API keys, wallet keys, signed payloads, or unrestricted
backend errors.

### Service

`AomiService` owns the durable conversational state:

- One Aomi `ClientSession` per elizaOS room.
- The pending wallet request for that room.
- The `entityId` of the user who initiated the operation.
- Shared execution and settlement promises used to prevent duplicate work.

This lets follow-up requests continue the same Aomi thread while keeping wallet
approval bound to the correct conversation and user.

## Read-only request

Read-only research does not require wallet confirmation:

```mermaid
sequenceDiagram
    participant User
    participant Eliza as elizaOS
    participant Plugin as Aomi plugin
    participant Aomi
    participant Chain as Blockchain

    User->>Eliza: Ask an on-chain question
    Eliza->>Plugin: Run the AOMI action
    Plugin->>Aomi: Submit prompt and wallet addresses
    Aomi->>Chain: Read public chain data
    Chain-->>Aomi: Balances and protocol data
    Aomi-->>Plugin: Analysis and recommendations
    Plugin-->>Eliza: Completed response
    Eliza-->>User: Explain the result
```

The plugin sends connected public addresses to Aomi so it can contextualize the
request. It does not send wallet credentials.

## Wallet request

A wallet operation always takes at least two user turns:

```mermaid
sequenceDiagram
    participant User
    participant Eliza as elizaOS
    participant Plugin as Aomi plugin
    participant Aomi
    participant Wallet as Wallet plugin
    participant Chain as Blockchain

    User->>Eliza: Request an on-chain operation
    Eliza->>Plugin: Run AOMI
    Plugin->>Aomi: Prepare the operation
    Aomi-->>Plugin: Unsigned wallet request

    Plugin->>Plugin: Decode and validate request
    Plugin-->>User: Show exact confirmation preview

    User->>Plugin: yes
    Plugin->>Plugin: Verify same room and user
    Plugin->>Wallet: Sign validated request
    Wallet->>Chain: Submit transaction
    Chain-->>Wallet: Transaction result
    Wallet-->>Plugin: Execution result
    Plugin->>Aomi: Resume thread with result
    Aomi-->>Plugin: Final explanation
    Plugin-->>User: Report the result
```

The initial request authorizes planning only. It never authorizes the resulting
wallet write. LLM-supplied confirmation flags are ignored; confirmation state
is held by the runtime.

## Confirmation state machine

```mermaid
flowchart TD
    R["Aomi returns a wallet request"] --> D{"Can the plugin fully decode it?"}

    D -->|"No"| X["Reject without signing"]
    D -->|"Yes"| V["Show exact confirmation preview"]

    V --> C{"Did the initiating user confirm?"}
    C -->|"No or different user"| N["Reject or leave pending"]
    C -->|"Yes"| L{"Execution already started?"}

    L -->|"Yes"| S["Return shared in-flight result"]
    L -->|"No"| E["Store one execution promise"]

    E --> W["Revalidate at signing boundary"]
    W --> G["Wallet plugin signs and submits"]
    G --> A["Return result to Aomi"]
```

Pending confirmation is bound to:

- The elizaOS room.
- The exact Aomi request.
- The initiating user’s `entityId`.

The service stores the in-flight promise synchronously before awaiting wallet
execution. Concurrent `yes` messages therefore share one execution instead of
broadcasting the same transaction twice.

The wallet execution promise is retained separately from the Aomi callback. If
notifying Aomi fails, a retry may settle the Aomi request again but cannot
rebroadcast the blockchain transaction.

## Trust and authority

```mermaid
flowchart LR
    M["elizaOS model"] -->|"Chooses action"| P["Aomi plugin"]
    P -->|"Requests a plan"| A["Aomi"]
    A -->|"Proposes wallet operation"| P
    P -->|"Enforces deterministic policy"| W["Wallet boundary"]
    W -->|"Signs after confirmation"| C["Blockchain"]
```

- The model decides when Aomi is an appropriate tool.
- Aomi proposes research or a wallet operation.
- Deterministic plugin code validates the proposed operation.
- The initiating user provides final approval.
- The wallet plugin signs and submits.

Model output cannot bypass the coded safety boundary.

## Wallet execution boundary

`src/wallet.ts` is the only signing and execution boundary. It reaches signing
through `WalletBackendService` supplied by `@elizaos/plugin-wallet`.

### EVM

The initial release supports:

- A single EVM transaction.
- EIP-712 typed-data signatures.
- Displayable message signatures.

The preview includes the chain, target, value, call data, or exact signature
payload. EVM batches are rejected until the wallet backend provides an atomic
batch primitive.

### Solana

The initial release deliberately supports only fully decoded native SOL
`SystemProgram.transfer` instructions. The preview includes:

- Fee payer and transfer source.
- Recipient.
- Amount in lamports and SOL.
- Program and instruction count.
- Payload byte length and hash.

The plugin rejects:

- SPL token instructions.
- Unknown programs.
- Address lookup tables.
- Non-transfer System Program instructions.
- A fee payer or transfer source that is not the connected wallet.
- Missing, malformed, opaque, or non-displayable signing payloads.

Unsupported Solana activity fails closed instead of asking the user to sign an
opaque byte sequence.

## Source map

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Registers and exports the plugin |
| `src/action.ts` | Handles requests, confirmations, and rejections |
| `src/provider.ts` | Supplies bounded Aomi and wallet context |
| `src/service.ts` | Owns sessions, pending state, and single-flight execution |
| `src/routing.ts` | Routes explicit Aomi requests to the action |
| `src/wallet.ts` | Validates, previews, signs, and submits wallet requests |
| `src/wallet-backend.ts` | Defines the wallet-plugin service boundary |

