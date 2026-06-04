# ADR: Watchdog Detection Engine

## Status
Validated. Ready for MVP implementation.

## Context
We're building a self-serve smart contract monitoring tool for small DeFi protocols ($100K-$10M TVL) that can't afford enterprise solutions ($5K-50K+/mo). The engine needs to detect exploits with near-zero false positives using only data available from transaction receipts — no contract instrumentation, no proprietary data feeds.

We backtested against 7 real exploits totaling $204M in losses across 5 different attack types on 2 chains. We iterated through 7 versions of the detection approach before arriving at one that generalizes.

## Decision
Multi-signal conjunction scoring across three independent signal groups. Alert fires when **any signal scores >= 5 AND at least 2 signal groups score >= 4.**

### Signal Groups

**Group 1 — Caller Profile** (cost: 0, from tx receipt)
```
S1.1  Caller never interacted with this contract before → 6
S1.2  Caller funded by Tornado Cash / mixer (1-2 hops) → 10
S1.3  Caller account age < 24h → 6, < 1h → 8
```

**Group 2 — Transaction Structure** (cost: 0, from tx receipt)
```
S2.1  Gas used > baseline max → 8, > p95 → 4
S2.2  Function selector never seen in baseline → 7
S2.3  Contract deployment (no `to` address) → 7
S2.4  Log count > baseline max → 7, > 2x p95 → 5
S2.5  Novel event topic (topic0 not in baseline) → 7
```

**Group 3 — Token Flow** (cost: 0, from Transfer events in receipt)
```
S3.1  Outflow > max(baseline p99, 3x p95) → 7-10
S3.2  Transfer to address never seen as destination → 5, multiple → 6
S3.3  Token contract never seen in baseline → 6
S3.4  Transfer count > baseline max → 6
```

### Scoring Rule
```
per_group_score = max of all signals in that group
groups_firing   = count of groups with score >= 4
alert           = max(per_group_scores) >= 5 AND groups_firing >= 2
```

Single-signal anomalies are suppressed. Attacks produce correlated anomalies across independent dimensions. Legitimate transactions don't.

## Validation Results

Tested against 7 real exploits, 980 baseline transactions:

```
Hack             $Lost    Type                Detection  FP/BL   FP%
─────────────────────────────────────────────────────────────────────
NMT Module       $3.2M    Module exploit      51%*       0/261   0.0%
Makina           $4.1M    Flash loan oracle   91%        0/257   0.0%
CrossCurve       $3M      Bridge spoof        100%       0/132   0.0%
Verus Bridge     $11.6M   Bridge validation   100%       0/183   0.0%
Balancer V2      $128M    Rounding error      100%       0/80    0.0%
GMX V1           $42M     Reentrancy          100%       1/58    1.7%
Cork Protocol    $12M     Rate manipulation   100%       0/9     0.0%
─────────────────────────────────────────────────────────────────────
TOTAL            $204M                        7/7 hacks  1/980   0.1%

* NMT 51% = per-tx rate. 49% of attack txs delivered by known relayers
  at normal gas. These are the irreducible limit of external monitoring
  for relay-delivered attacks without contract-level instrumentation.
```

Every detected tx was verified on-chain: correct attacker address, correct victim contract, correct token movements matching public post-mortem reports.

### Which signals fired per hack

| Hack | G1 (caller) | G2 (structure) | G3 (flow) |
|---|---|---|---|
| NMT | new caller (6) | gas > p95 (4) | — |
| Makina | new caller (6) | gas > max (8) | new destinations (6) |
| CrossCurve | new caller (6) | new selector (7) | — |
| Verus | new caller (6) | new selector + gas (8) | transfers (7) |
| Balancer | new caller (6) | gas 10x + deploy + logs (8) | transfers (6) |
| GMX | — | gas > max + logs (8) | transfers > max (6) |
| Cork | — | gas > max + novel events (8) | new destinations (6) |

GMX and Cork detected WITHOUT a new caller — G2+G3 alone is sufficient. This is critical: the engine doesn't depend on the attacker being unknown.

## Alternatives Considered

### v1-v3: Caller + selector analysis
- Failed on NMT (attacker was known caller using known selectors)
- 11-25% FP rates from fat-tailed value distributions
- Rejected: too narrow, too many FPs

### v4: Balance monitoring (Transfer events from/to contract)
- Works for asset-holding contracts (Makina 100%, CrossCurve 100%)
- Fails for proxy/module contracts (NMT, Verus — they don't hold tokens)
- Rejected as sole approach: doesn't generalize

### v5: Graph discovery + trace analysis
- Call tree unknown-address count: 100% detection on NMT but 68% FP on others
- Zero-balance-new-contract heuristic: 100%/8% FP on NMT, doesn't generalize
- Rejected: overfit to NMT's drain-through-pool pattern

### v6: Call flow structure hashing (inspired by CrossGuard)
- Every tx produces a unique hash — 100% FP
- Structural profiles also too unique — DeFi txs are highly variable
- Rejected: traces are too diverse for hash-based novelty detection

### v7: Semantic operation categories (inspired by GenDetect)
- Worked on NMT with limited baseline but breaks when baseline includes legitimate swaps
- Attack does the same financial operations as normal usage
- Rejected: same operations, different routing — semantic categories identical

### Multi-signal conjunction (chosen)
- Converges on the insight from GenDetect/CrossGuard research: attacks produce correlated anomalies across multiple independent dimensions
- No single signal is reliable. Requiring 2+ independent signals eliminates single-cause FPs
- Uses only receipt data — no traces needed for core detection (traces reserved for alert explanation)

## Consequences

### What this enables
- Core detection engine with 0.1% FP rate on validated data
- No contract instrumentation required — fully external
- No traces for detection — traces only on-demand for alert explanation
- Works across 5 different attack types without per-type tuning
- Baseline auto-calibrates from each contract's own history

### What this doesn't solve
- **Relay-delivered attacks** where the attacker's payload is carried by a known relayer at normal gas (49% of NMT attack txs). Requires contract-level guards or payload analysis
- **Single-tx drains** detected post-facto. Requires mempool monitoring + frontrunning for prevention (Layer 2, future work)
- **Slow-burn attacks** (Venus Protocol 9-month position buildup). Per-tx signals don't detect gradual accumulation

### Baseline requirements
- Minimum 7 days of contract history (30 days preferred)
- At least 5 txs with outflows for meaningful G3 calibration
- Contracts with <5 baseline txs use conservative absolute thresholds

### Cost
- Per tx scored: $0 (receipt data only)
- Baseline computation: one-time, ~$0.02 in RPC calls
- Trace on alert (optional enrichment): ~$0.00002 per trace
- Infrastructure: event subscription + baseline storage
- Total: < $5/month for typical small protocol

## Implementation

### Phase 1 (MVP): Confirmed tx monitoring
- Subscribe to events on monitored contract
- For each new tx: fetch receipt, compute 3-group scores, check conjunction
- If alert: send Telegram notification with decoded tx summary
- Haiku generates plain-English alert text (presentation only, not scoring)

### Phase 2: Enrichment
- On alert: trace the tx for call-path explanation
- Check caller funding source (1-2 hops) for Tornado Cash / mixer links
- Upgrade G1 scoring with funding source data

### Phase 3: Mempool monitoring
- Subscribe to pending txs via bloXroute ($300/mo)
- Run same scoring engine on pending txs
- If alert: submit frontrun pause tx via Flashbots Protect
- Enables prevention of single-tx drains

### Phase 4: Graph discovery
- At onboarding: trace historical txs to discover protocol topology
- Auto-identify asset-holding contracts vs modules
- Apply monitoring to the right contracts automatically
