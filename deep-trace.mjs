/**
 * Deep multi-hop fund flow tracing for all 7 hacks.
 *
 * For each hack:
 *   1. FUNDING SOURCES: trace inbound to attacker BEFORE the hack (where did gas ETH come from?)
 *   2. MONEY DESTINATIONS: trace outbound from attacker AFTER the hack (where did stolen funds go?)
 *   3. Multi-hop BFS (up to 3 hops) to find mixers, CEX deposits, bridges
 *   4. Label all known addresses and classify nodes
 *
 * APIs: Alchemy (ETH tx history + internal txs) + Bitquery (token transfers)
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";

const ALCHEMY_ETH = "https://eth-mainnet.g.alchemy.com/v2/Ov3ptXr915i4K30KHxATA";
const ALCHEMY_ARB = "https://arb-mainnet.g.alchemy.com/v2/Ov3ptXr915i4K30KHxATA";
const CACHE_DIR = "./graph-data";
const TRACE_CACHE = "./graph-data/trace-cache";
if (!existsSync(TRACE_CACHE)) mkdirSync(TRACE_CACHE, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// KNOWN ADDRESS DATABASE
// ─────────────────────────────────────────────────────────────

const KNOWN_ADDRESSES = {
  // ── Tornado Cash ──
  "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b": { label: "Tornado Cash Router", type: "mixer" },
  "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc": { label: "Tornado Cash 0.1 ETH", type: "mixer" },
  "0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936": { label: "Tornado Cash 1 ETH", type: "mixer" },
  "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf": { label: "Tornado Cash 10 ETH", type: "mixer" },
  "0xa160cdab225685da1d56aa342ad8841c3b53f291": { label: "Tornado Cash 100 ETH", type: "mixer" },
  "0x722122df12d4e14e13ac3b6895a86e84145b6967": { label: "Tornado Cash Proxy", type: "mixer" },
  "0xfd8610d20aa15b7b2e3be39b396a1bc3516c7144": { label: "Tornado Cash 100 ETH (2)", type: "mixer" },
  "0xba214c1c1928a32bffe790263e38b4af9bfcd659": { label: "Tornado Cash 1000 DAI", type: "mixer" },
  "0xd4b88df4d29f5cedd6857912842cff3b20c8cfa3": { label: "Tornado Cash 100 DAI", type: "mixer" },
  "0x169ad27a470d064dede56a2d3ff727986b15d52b": { label: "Tornado Cash 0.1 ETH (old)", type: "mixer" },
  "0x0836222f2b2b24a3f36f98668ed8f0b38d1a872f": { label: "Tornado Cash 0.1 ETH (3)", type: "mixer" },
  "0x178169b423a011fff22b9e3f3abea13414ddd0f1": { label: "Tornado Cash Echoer", type: "mixer" },
  "0x23773e65ed146a459791799d01336db287f25334": { label: "Tornado Cash (Gitcoin)", type: "mixer" },

  // ── Railgun ──
  "0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9": { label: "Railgun Relay", type: "mixer" },
  "0xc0d3c0d3c0d3c0d3c0d3c0d3c0d3c0d3c0d30001": { label: "Railgun", type: "mixer" },

  // ── Binance ──
  "0x28c6c06298d514db089934071355e5743bf21d60": { label: "Binance 14", type: "cex" },
  "0x21a31ee1afc51d94c2efccaa2092ad1028285549": { label: "Binance 15", type: "cex" },
  "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": { label: "Binance 16", type: "cex" },
  "0x56eddb7aa87536c09ccc2793473599fd21a8b17f": { label: "Binance 17", type: "cex" },
  "0x9696f59e4d72e237be84ffd425dcad154bf96976": { label: "Binance 18", type: "cex" },
  "0x4976a4a02f38326660d17bf34b431dc6e2eb2327": { label: "Binance 19", type: "cex" },
  "0xf977814e90da44bfa03b6295a0616a897441acec": { label: "Binance 8", type: "cex" },
  "0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be": { label: "Binance 1", type: "cex" },
  "0xd551234ae421e3bcba99a0da6d736074f22192ff": { label: "Binance 2", type: "cex" },
  "0x564286362092d8e7936f0549571a803b203aaced": { label: "Binance 3", type: "cex" },
  "0x0681d8db095565fe8a346fa0277bffde9c0edbbf": { label: "Binance 4", type: "cex" },
  "0xfe9e8709d3215310075d67e3ed32a380ccf451c8": { label: "Binance 5", type: "cex" },
  "0x4e9ce36e442e55ecd9025b9a6e0d88485d628a67": { label: "Binance 6", type: "cex" },
  "0xbe0eb53f46cd790cd13851d5eff43d12404d33e8": { label: "Binance 7", type: "cex" },
  "0x8894e0a0c962cb723c1ef8a1b2c6d10b0527c8a5": { label: "Binance 20", type: "cex" },
  "0xe2fc31f816a9b94326492132018c3aecc4a93ae1": { label: "Binance 21", type: "cex" },
  "0xb3f923eabaf178fc1bd8e13902fc5c61d3ddef5b": { label: "Binance Pool", type: "cex" },

  // ── Coinbase ──
  "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": { label: "Coinbase 1", type: "cex" },
  "0x503828976d22510aad0201ac7ec88293211d23da": { label: "Coinbase 2", type: "cex" },
  "0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740": { label: "Coinbase 3", type: "cex" },
  "0x3cd751e6b0078be393132286c442345e68ff0aff": { label: "Coinbase 4", type: "cex" },
  "0xb5d85cbf7cb3ee0d56b3bb207d5fc4b82f43f511": { label: "Coinbase 5", type: "cex" },
  "0xeb2629a2734e272bcc07bda959863f316f4bd4cf": { label: "Coinbase 6", type: "cex" },
  "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43": { label: "Coinbase 10", type: "cex" },
  "0x77134cbc06cb00b66f4c7e623d5fdbf6777635ec": { label: "Coinbase Commerce", type: "cex" },
  "0xd688aea8f7d450909ade10c47faa95707b0682d9": { label: "Coinbase Custody", type: "cex" },

  // ── Kraken ──
  "0x2910543af39aba0cd09dbb2d50200b3e800a63d2": { label: "Kraken 1", type: "cex" },
  "0x0a869d79a7052c7f1b55a8ebabbea3420f0d1e13": { label: "Kraken 2", type: "cex" },
  "0xe853c56864a2ebe4576a807d26fdc4a0ada51919": { label: "Kraken 3", type: "cex" },
  "0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0": { label: "Kraken 4", type: "cex" },
  "0xfa52274dd61e1643d2205169732f29114bc240b3": { label: "Kraken 5", type: "cex" },
  "0xae2d4617c862309a3d75a0ffb358c7a5009c673f": { label: "Kraken 6", type: "cex" },
  "0x43984d578803891dfa9706bdeee6078d80cfc668": { label: "Kraken 7", type: "cex" },
  "0x66c57bf505a85a74609d2c83e94aabb26d691cf1": { label: "Kraken 8", type: "cex" },
  "0xda9dfa130df4de4673b89022ee50ff26f6ea73cf": { label: "Kraken 9", type: "cex" },
  "0xa83b11093c858c86321fbc4c20fe82cdbd58e09e": { label: "Kraken 10", type: "cex" },

  // ── OKX ──
  "0x6cc5f688a315f3dc28a7781717a9a798a59fda7b": { label: "OKX 1", type: "cex" },
  "0x236f9f97e0e62388479bf9e5ba4889e46b0273c3": { label: "OKX 2", type: "cex" },
  "0xa7efae728d2936e78bda97dc267687568dd593f3": { label: "OKX 3", type: "cex" },
  "0x98ec059dc3adfbdd63429227115656b07c44a3dc": { label: "OKX", type: "cex" },
  "0x5041ed759dd4afc3a72b8192c143f72f4724081a": { label: "OKX 4", type: "cex" },

  // ── Bybit ──
  "0xf89d7b9c864f589bbf53a82105107622b35eaa40": { label: "Bybit 1", type: "cex" },
  "0x1db92e2eebc8e0c075a02bea49a2935bcd2dfcf4": { label: "Bybit 2", type: "cex" },

  // ── KuCoin ──
  "0xf16e9b0d03470827a95cdfd0cb8a8a3b46969b91": { label: "KuCoin 1", type: "cex" },
  "0xd6216fc19db775df9774a6e33526131da7d19a2c": { label: "KuCoin 2", type: "cex" },
  "0x88ff79eb2bc5850f27315138b8c5d26f3f8e1a11": { label: "KuCoin Pool", type: "cex" },

  // ── Huobi / HTX ──
  "0xab5c66752a9e8167967685f1450532fb96d5d24f": { label: "Huobi 1", type: "cex" },
  "0x6748f50f686bfbca6fe8ad62b22228b87f31ff2b": { label: "Huobi 2", type: "cex" },
  "0xfdb16996831753d5331ff813c29a93c76834a0ad": { label: "Huobi 3", type: "cex" },
  "0xeee27662c2b8eba3cd936a23f039f3189633e4c8": { label: "Huobi 4", type: "cex" },
  "0x5c985e89dde482efe97ea9f1950ad149eb73829b": { label: "Huobi 5", type: "cex" },
  "0xdc76cd25977e0a5ae17155770273ad58648900d3": { label: "Huobi 6", type: "cex" },

  // ── Gate.io ──
  "0x0d0707963952f2fba59dd06f2b425ace40b492fe": { label: "Gate.io 1", type: "cex" },
  "0x7793cd85c11a924478d358d49b05b37e91b5810f": { label: "Gate.io 2", type: "cex" },
  "0x1c4b70a3968436b9a0a9cf5205c787eb81bb558c": { label: "Gate.io 3", type: "cex" },

  // ── FixedFloat ──
  "0x4e5b2e1dc63f6b91cb6cd759936495434c7e972f": { label: "FixedFloat", type: "cex" },
  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": { label: "FixedFloat 2", type: "cex" },

  // ── eXch ──
  "0xb8547d4822f5e8042e55e50f31fd1de1133f4951": { label: "eXch", type: "cex" },
  "0xedbb69ba82f00b10f6dd9e15e76e8c93c6e5103c": { label: "eXch Hot", type: "cex" },

  // ── Bridges ──
  "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae": { label: "LiFi Diamond", type: "bridge" },
  "0x3a23f943181408eac424116af7b7790c94cb97a5": { label: "Socket Gateway", type: "bridge" },
  "0x2796317b0ff8538f253012862c06787adfb8ceb6": { label: "Synapse Bridge", type: "bridge" },
  "0xb8901acb165ed027e32754e0ffe830802919727f": { label: "Hop Protocol ETH", type: "bridge" },
  "0x4c36d2919e407f0cc2ee3c993ccf8ac26d9ce64e": { label: "Across Bridge V2", type: "bridge" },
  "0x5427fefa711eff984124bfbb1ab6fbf5e3da1820": { label: "Across Bridge V3", type: "bridge" },
  "0x6571d6be3d8460cf5f7d6711cd9961860029d85f": { label: "Across SpokePool", type: "bridge" },
  "0x8eb8a3b98659cce290402893d0123abb75e3ab28": { label: "Avalanche Bridge", type: "bridge" },
  "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf": { label: "Polygon Bridge", type: "bridge" },
  "0xa0c68c638235ee32657e8f720a23cec1bfc6c9a8": { label: "Polygon Bridge 2", type: "bridge" },
  "0x3ee18b2214aff97000d974cf647e7c347e8fa585": { label: "Wormhole", type: "bridge" },
  "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1": { label: "Optimism Bridge", type: "bridge" },
  "0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f": { label: "Arbitrum Bridge", type: "bridge" },
  "0xabea9132b05a70803a4e85094fd0e1800777fbef": { label: "zkSync Bridge", type: "bridge" },
  "0x2dccdb493827e15a5dc8f8b72147e6c4a5620857": { label: "Thorchain Router", type: "bridge" },
  "0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146": { label: "THORChain Router 4", type: "bridge" },
  "0x3624525075b88b24ecc29ce226b0cec1ffcb6976": { label: "Multichain Router", type: "bridge" },
  "0xe4edb277e41dc89ab076a1f049f4a3efa700bce8": { label: "Orbiter Finance", type: "bridge" },

  // ── DEX Routers ──
  "0x7a250d5630b4cf539739df2c5dacb4c659f2488d": { label: "Uniswap V2 Router", type: "defi" },
  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": { label: "Uniswap V3 Router2", type: "defi" },
  "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": { label: "Uniswap Universal Router", type: "defi" },
  "0xe592427a0aece92de3edee1f18e0157c05861564": { label: "Uniswap V3 Router", type: "defi" },
  "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f": { label: "SushiSwap Router", type: "defi" },
  "0x1111111254eeb25477b68fb85ed929f73a960582": { label: "1inch V5", type: "defi" },
  "0x1111111254fb6c44bac0bed2854e76f90643097d": { label: "1inch V4", type: "defi" },
  "0x111111125421ca6dc452d289314280a0f8842a65": { label: "1inch V6", type: "defi" },
  "0xdef1c0ded9bec7f1a1670819833240f027b25eff": { label: "0x Exchange Proxy", type: "defi" },
  "0x9008d19f58aabd9ed0d60971565aa8510560ab41": { label: "CoW Protocol", type: "defi" },
  "0x6131b5fae19ea4f9d964eac0408e4408b66337b5": { label: "Kyber Router", type: "defi" },

  // ── Lending / DeFi ──
  "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9": { label: "Aave V2 Pool", type: "defi" },
  "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2": { label: "Aave V3 Pool", type: "defi" },
  "0xba12222222228d8ba445958a75a0704d566bf2c8": { label: "Balancer Vault", type: "defi" },
  "0xbebc44782c7db0a1a60b1b98a6202171942db296": { label: "Curve 3pool", type: "defi" },
  "0x000000000022d473030f116ddee9f6b43ac78ba3": { label: "Permit2", type: "defi" },

  // ── Tokens ──
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { label: "WETH", type: "token" },
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { label: "USDC", type: "token" },
  "0xdac17f958d2ee523a2206206994597c13d831ec7": { label: "USDT", type: "token" },
  "0x6b175474e89094c44da98b954eedeac495271d0f": { label: "DAI", type: "token" },

  // ── Null ──
  "0x0000000000000000000000000000000000000000": { label: "Null Address", type: "null" },
};

// Build lookup set for fast matching
const KNOWN_SET = new Map(Object.entries(KNOWN_ADDRESSES).map(([k, v]) => [k.toLowerCase(), v]));

function labelAddress(addr) {
  const a = addr.toLowerCase();
  return KNOWN_SET.get(a) || null;
}

// ─────────────────────────────────────────────────────────────
// API HELPERS
// ─────────────────────────────────────────────────────────────

async function alchemyCall(rpcUrl, method, params) {
  await sleep(200);
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const d = await res.json();
  if (d.error) { console.error(`    Alchemy error: ${d.error.message}`); return null; }
  return d.result;
}

// Get ETH + internal txs via alchemy_getAssetTransfers
async function getTransfers(rpcUrl, address, direction, opts = {}) {
  const { fromBlock, toBlock, maxCount = 100 } = opts;
  // Arbitrum doesn't support 'internal' category
  const isArb = rpcUrl.includes("arb-");
  const params = {
    category: isArb ? ["external", "erc20"] : ["external", "internal", "erc20"],
    maxCount: `0x${maxCount.toString(16)}`,
    withMetadata: true,
    excludeZeroValue: true,
  };
  if (direction === "out") params.fromAddress = address;
  else params.toAddress = address;
  if (fromBlock) params.fromBlock = fromBlock;
  if (toBlock) params.toBlock = toBlock;

  const result = await alchemyCall(rpcUrl, "alchemy_getAssetTransfers", [params]);
  return result?.transfers || [];
}

// ─────────────────────────────────────────────────────────────
// DEEP TRACER
// ─────────────────────────────────────────────────────────────

async function deepTrace(hack) {
  const cacheFile = `${TRACE_CACHE}/${hack.id}-deep.json`;
  if (existsSync(cacheFile)) {
    console.log(`  ${hack.name}: CACHED (deep trace)`);
    return JSON.parse(readFileSync(cacheFile, "utf8"));
  }

  console.log(`\n━━━ ${hack.name} ━━━`);

  const nodes = new Map();
  const edges = new Map();
  const attackerSet = new Set(hack.attackerAddresses.map(a => a.toLowerCase()));

  function ensureNode(addr, extra = {}) {
    const a = addr.toLowerCase();
    if (a === "0x0000000000000000000000000000000000000000") return null;
    if (!nodes.has(a)) {
      const known = labelAddress(a);
      const isAttacker = attackerSet.has(a);
      nodes.set(a, {
        address: a,
        label: hack.labels[a] || hack.labels[addr] || known?.label || a.slice(0, 10),
        type: isAttacker ? "attacker" : (known?.type || "unknown"),
        totalUsd: 0,
        totalEth: 0,
        tokens: new Set(),
        hop: extra.hop ?? 99,
        direction: extra.direction || "unknown",
      });
    }
    const n = nodes.get(a);
    if (extra.hop !== undefined && extra.hop < n.hop) n.hop = extra.hop;
    return n;
  }

  function addEdge(from, to, usd, eth, token, direction) {
    const key = `${from.toLowerCase()}→${to.toLowerCase()}`;
    if (!edges.has(key)) {
      edges.set(key, { from: from.toLowerCase(), to: to.toLowerCase(), totalUsd: 0, totalEth: 0, count: 0, tokens: new Set(), direction });
    }
    const e = edges.get(key);
    e.totalUsd += usd;
    e.totalEth += eth;
    e.count++;
    if (token) e.tokens.add(token);
  }

  // ─── PHASE 1: Funding sources (inbound to attacker before hack) ───
  console.log("  Phase 1: Funding sources...");
  const fundingSources = new Set();

  for (const addr of hack.attackerAddresses) {
    const a = addr.toLowerCase();
    ensureNode(a, { hop: 0, direction: "attacker" });

    // Alchemy: inbound transfers to attacker (before hack block)
    console.log(`    Funding for ${a.slice(0, 14)}...`);
    const inbound = await getTransfers(hack.rpcUrl, a, "in", {
      toBlock: hack.attackBlock ? `0x${(hack.attackBlock - 1).toString(16)}` : undefined,
      maxCount: 50,
    });

    for (const tx of inbound) {
      const sender = tx.from?.toLowerCase();
      if (!sender || sender === a) continue;
      const usd = parseFloat(tx.value || 0) * (tx.asset === "ETH" ? 2500 : 1); // rough USD
      const eth = tx.asset === "ETH" ? parseFloat(tx.value || 0) : 0;

      const sNode = ensureNode(sender, { hop: 1, direction: "funding" });
      if (!sNode) continue;
      addEdge(sender, a, usd, eth, tx.asset || "ETH", "funding");
      fundingSources.add(sender);

      sNode.totalUsd += usd;
      sNode.totalEth += eth;
      if (tx.asset) sNode.tokens.add(tx.asset);
    }
    console.log(`      → ${inbound.length} inbound txs, ${fundingSources.size} sources`);

    // Hop 2: trace where funding sources got THEIR funds
    for (const source of [...fundingSources]) {
      const known = labelAddress(source);
      if (known) continue; // Already identified (mixer, CEX, etc.)

      console.log(`    Funding hop 2: ${source.slice(0, 14)}...`);
      const hop2in = await getTransfers(hack.rpcUrl, source, "in", { maxCount: 20 });

      for (const tx of hop2in) {
        const sender2 = tx.from?.toLowerCase();
        if (!sender2 || sender2 === source) continue;
        const eth = tx.asset === "ETH" ? parseFloat(tx.value || 0) : 0;
        const usd = eth * 2500;

        if (eth < 0.01) continue; // skip dust
        if (!ensureNode(sender2, { hop: 2, direction: "funding" })) continue;
        addEdge(sender2, source, usd, eth, tx.asset || "ETH", "funding");
      }
    }
  }

  // ─── PHASE 2: Money destinations (outbound from attacker after hack) ───
  console.log("  Phase 2: Money destinations...");
  const hop1Destinations = new Set();

  for (const addr of hack.attackerAddresses) {
    const a = addr.toLowerCase();

    // Alchemy: outbound from attacker
    console.log(`    Outbound from ${a.slice(0, 14)}...`);
    const outbound = await getTransfers(hack.rpcUrl, a, "out", { maxCount: 100 });

    for (const tx of outbound) {
      const receiver = tx.to?.toLowerCase();
      if (!receiver || receiver === a) continue;
      const val = parseFloat(tx.value || 0);
      const eth = (tx.asset === "ETH" || tx.asset === "WETH") ? val : 0;
      // Rough USD: ETH/WETH at ~2500, stablecoins at 1, others estimate
      const isStable = ["USDC", "USDT", "DAI", "BUSD", "FRAX", "LUSD", "USDD"].includes(tx.asset);
      const usd = isStable ? val : eth * 2500 + ((!eth && !isStable) ? val : 0);

      const rNode = ensureNode(receiver, { hop: 1, direction: "destination" });
      if (!rNode) continue;
      addEdge(a, receiver, usd, eth, tx.asset || "ETH", "destination");
      hop1Destinations.add(receiver);

      rNode.totalUsd += usd;
      rNode.totalEth += eth;
      if (tx.asset) rNode.tokens.add(tx.asset);
    }
    console.log(`      → ${outbound.length} outbound txs, ${hop1Destinations.size} destinations`);
  }

  // ─── PHASE 3: Hop 2-3 from destinations ───
  console.log("  Phase 3: Deep destination tracing (hop 2-3)...");

  // Sort hop1 destinations by value, trace the top ones
  const hop1Sorted = [...hop1Destinations]
    .filter(a => {
      const n = nodes.get(a);
      const known = labelAddress(a);
      // Skip if already terminal (mixer, cex, bridge) or null
      return n && !known?.type?.match(/mixer|cex|bridge|null|token/) && n.totalUsd > 100;
    })
    .sort((a, b) => (nodes.get(b)?.totalUsd || 0) - (nodes.get(a)?.totalUsd || 0))
    .slice(0, 8); // Top 8 by value

  for (const dest of hop1Sorted) {
    console.log(`    Hop 2: ${dest.slice(0, 14)} ($${Math.round(nodes.get(dest)?.totalUsd || 0)})...`);

    const outbound2 = await getTransfers(hack.rpcUrl, dest, "out", { maxCount: 30 });
    const hop2Dests = new Set();

    for (const tx of outbound2) {
      const receiver = tx.to?.toLowerCase();
      if (!receiver || receiver === dest) continue;
      const eth = tx.asset === "ETH" ? parseFloat(tx.value || 0) : 0;
      const usd = eth * 2500 + (tx.asset !== "ETH" ? parseFloat(tx.value || 0) : 0);

      if (usd < 10 && eth < 0.01) continue;
      const rNode = ensureNode(receiver, { hop: 2, direction: "destination" });
      if (!rNode) continue;
      addEdge(dest, receiver, usd, eth, tx.asset || "ETH", "destination");
      hop2Dests.add(receiver);

      rNode.totalUsd += usd;
      rNode.totalEth += eth;
      if (tx.asset) rNode.tokens.add(tx.asset);
    }
    console.log(`      → ${outbound2.length} txs, ${hop2Dests.size} new destinations`);

    // Hop 3: trace top hop2 destinations
    const hop2Sorted = [...hop2Dests]
      .filter(a => {
        const known = labelAddress(a);
        return !known?.type?.match(/mixer|cex|bridge|null|token/) && (nodes.get(a)?.totalUsd || 0) > 500;
      })
      .sort((a, b) => (nodes.get(b)?.totalUsd || 0) - (nodes.get(a)?.totalUsd || 0))
      .slice(0, 4);

    for (const dest2 of hop2Sorted) {
      console.log(`    Hop 3: ${dest2.slice(0, 14)} ($${Math.round(nodes.get(dest2)?.totalUsd || 0)})...`);

      const outbound3 = await getTransfers(hack.rpcUrl, dest2, "out", { maxCount: 20 });
      for (const tx of outbound3) {
        const receiver = tx.to?.toLowerCase();
        if (!receiver || receiver === dest2) continue;
        const eth = tx.asset === "ETH" ? parseFloat(tx.value || 0) : 0;
        const usd = eth * 2500;

        if (usd < 10 && eth < 0.01) continue;
        const rNode = ensureNode(receiver, { hop: 3, direction: "destination" });
        if (!rNode) continue;
        addEdge(dest2, receiver, usd, eth, tx.asset || "ETH", "destination");

        rNode.totalUsd += usd;
        rNode.totalEth += eth;
        if (tx.asset) rNode.tokens.add(tx.asset);
      }
    }
  }

  // ─── PHASE 4: Classify nodes ───
  console.log("  Phase 4: Classifying nodes...");

  // Propagate trail from attacker
  const trailQueue = [...attackerSet];
  const trailVisited = new Set(trailQueue);

  while (trailQueue.length) {
    const addr = trailQueue.shift();
    edges.forEach(e => {
      if (e.from === addr && !trailVisited.has(e.to) && e.direction === "destination") {
        trailVisited.add(e.to);
        const n = nodes.get(e.to);
        if (n && n.type === "unknown") {
          n.type = "trail";
          if (e.totalUsd > 100 || e.totalEth > 0.05) trailQueue.push(e.to);
        }
      }
    });
  }

  // Classify funding path
  edges.forEach(e => {
    if (e.direction === "funding") {
      const n = nodes.get(e.from);
      if (n && n.type === "unknown") n.type = "funding_source";
    }
  });

  // Remove dust/noise nodes
  const finalNodes = new Map();
  const finalEdges = [];

  nodes.forEach((n, addr) => {
    // Keep: attackers, known addresses, trail with value, funding sources
    const keep = n.type === "attacker" ||
                 n.type === "mixer" || n.type === "cex" || n.type === "bridge" ||
                 n.type === "trail" ||
                 n.type === "funding_source" ||
                 n.type === "defi" ||
                 (n.totalUsd > 50 || n.totalEth > 0.01);
    if (keep) {
      finalNodes.set(addr, {
        ...n,
        tokens: [...n.tokens],
      });
    }
  });

  edges.forEach(e => {
    if (finalNodes.has(e.from) && finalNodes.has(e.to)) {
      finalEdges.push({
        ...e,
        tokens: [...e.tokens],
        isHot: trailVisited.has(e.from) || trailVisited.has(e.to) ||
               e.direction === "funding",
      });
    }
  });

  // Summary
  const typeCounts = {};
  finalNodes.forEach(n => { typeCounts[n.type] = (typeCounts[n.type] || 0) + 1; });
  console.log(`  Result: ${finalNodes.size} nodes ${JSON.stringify(typeCounts)}, ${finalEdges.length} edges`);

  // Find key discoveries
  const mixers = [...finalNodes.values()].filter(n => n.type === "mixer");
  const cexes = [...finalNodes.values()].filter(n => n.type === "cex");
  const bridges = [...finalNodes.values()].filter(n => n.type === "bridge");
  if (mixers.length) console.log(`  MIXERS: ${mixers.map(n => n.label).join(", ")}`);
  if (cexes.length) console.log(`  CEX: ${cexes.map(n => n.label).join(", ")}`);
  if (bridges.length) console.log(`  BRIDGES: ${bridges.map(n => n.label).join(", ")}`);

  const result = {
    name: hack.name,
    graph: {
      nodes: [...finalNodes.values()],
      edges: finalEdges,
    },
    meta: {
      mixers: mixers.map(n => ({ label: n.label, address: n.address })),
      cexes: cexes.map(n => ({ label: n.label, address: n.address })),
      bridges: bridges.map(n => ({ label: n.label, address: n.address })),
      fundingSources: [...finalNodes.values()].filter(n => n.direction === "funding" && n.type !== "attacker").length,
      maxHop: Math.max(...[...finalNodes.values()].map(n => n.hop)),
    },
  };

  writeFileSync(cacheFile, JSON.stringify(result, null, 2));
  return result;
}

// ─────────────────────────────────────────────────────────────
// HACK DEFINITIONS
// ─────────────────────────────────────────────────────────────

const HACKS = [
  {
    id: "balancer-v2", name: "Balancer V2", network: "eth", rpcUrl: ALCHEMY_ETH,
    attackBlock: 18040906,
    victimContract: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
    attackerAddresses: [
      "0x506d1f9efe24f0d47853adca907eb8d89ae03207",
      "0xAa760D53541d8390074c61DEFeaba314675b8e3f",
    ],
    labels: {
      "0x506d1f9efe24f0d47853adca907eb8d89ae03207": "ATTACKER: Deployer",
      "0xaa760d53541d8390074c61defeaba314675b8e3f": "ATTACKER: Recipient",
      "0xba12222222228d8ba445958a75a0704d566bf2c8": "Balancer Vault",
    },
  },
  {
    id: "gmx-v1", name: "GMX V1", network: "arbitrum", rpcUrl: ALCHEMY_ARB,
    attackBlock: 131036786,
    victimContract: "0x489ee077994b6658eafa855c308275ead8097c4a",
    attackerAddresses: [
      "0xd4266f8f82f7405429ee18559e548979d49160f3",
      "0x7D3BD50336f64b7a473c51f54e7f0bd6771cc355",
    ],
    labels: {
      "0xd4266f8f82f7405429ee18559e548979d49160f3": "ATTACKER: EOA",
      "0x7d3bd50336f64b7a473c51f54e7f0bd6771cc355": "ATTACKER: Contract",
      "0x489ee077994b6658eafa855c308275ead8097c4a": "GMX Vault",
    },
  },
  {
    id: "verus-bridge", name: "Verus Bridge", network: "eth", rpcUrl: ALCHEMY_ETH,
    attackBlock: 21607358,
    victimContract: "0x71518580f36feceffe0721f06ba4703218cd7f63",
    attackerAddresses: [
      "0x5aBb91B9c01A5Ed3aE762d32B236595B459D5777",
      "0x65Cb8b128Bf6e690761044CCECA422bb239C25F9",
    ],
    labels: {
      "0x5abb91b9c01a5ed3ae762d32b236595b459d5777": "ATTACKER: EOA",
      "0x65cb8b128bf6e690761044cceca422bb239c25f9": "ATTACKER: Consolidation",
      "0x71518580f36feceffe0721f06ba4703218cd7f63": "Verus Bridge",
    },
  },
  {
    id: "makina-finance", name: "Makina Finance", network: "eth", rpcUrl: ALCHEMY_ETH,
    attackBlock: 21715733,
    victimContract: "0x32E616F4f17d43f9A5cd9Be0e294727187064cb3",
    attackerAddresses: ["0x935bfb495E33f74d2E9735DF1DA66acE442ede48"],
    labels: {
      "0x935bfb495e33f74d2e9735df1da66ace442ede48": "ATTACKER: EOA",
      "0x32e616f4f17d43f9a5cd9be0e294727187064cb3": "DUSD Pool",
    },
  },
  {
    id: "crosscurve", name: "CrossCurve", network: "eth", rpcUrl: ALCHEMY_ETH,
    attackBlock: 21750000,
    victimContract: "0xAc8f44ceCa92b2a4b30360E5bd3043850a0FFcbE",
    attackerAddresses: ["0x632400f42e96a5deb547a179ca46b02c22cd25cd"],
    labels: {
      "0x632400f42e96a5deb547a179ca46b02c22cd25cd": "ATTACKER: EOA",
      "0xac8f44ceca92b2a4b30360e5bd3043850a0ffcbe": "PortalV2",
    },
  },
  {
    id: "nmt-module", name: "NMT Module", network: "eth", rpcUrl: ALCHEMY_ETH,
    attackBlock: 21684000,
    victimContract: "0x1f1d37a3Bf840e35c6a860c7c2dA71Fe555123ca",
    attackerAddresses: [
      "0x7c82cb4b2909c50c7c0f2b696eee7565e0a23bb8",
      "0x577fe2ff999ebd166fbbe21eb121ec413bbdbd3f",
    ],
    labels: {
      "0x7c82cb4b2909c50c7c0f2b696eee7565e0a23bb8": "ATTACKER: EOA 1",
      "0x577fe2ff999ebd166fbbe21eb121ec413bbdbd3f": "ATTACKER: EOA 2",
      "0x1f1d37a3bf840e35c6a860c7c2da71fe555123ca": "SquidRouter Module",
    },
  },
  {
    id: "cork-protocol", name: "Cork Protocol", network: "eth", rpcUrl: ALCHEMY_ETH,
    attackBlock: 22140000,
    victimContract: "0xCCd90F6435dd78C4ECCED1FA4db0D7242548a2a9",
    attackerAddresses: ["0xea6f30e360192bae715599e15e2f765b49e4da98"],
    labels: {
      "0xea6f30e360192bae715599e15e2f765b49e4da98": "ATTACKER: EOA",
      "0xccd90f6435dd78c4ecced1fa4db0d7242548a2a9": "Cork Vault",
    },
  },
];

// ─────────────────────────────────────────────────────────────
// MERGE INTO EXISTING GRAPH DATA
// ─────────────────────────────────────────────────────────────

function mergeGraphs(existing, deepTrace) {
  const nodes = new Map();
  const edges = new Map();

  // Add existing nodes
  for (const n of existing.graph.nodes) {
    nodes.set(n.address, { ...n });
  }

  // Merge deep trace nodes — add new ones, upgrade types of existing ones
  for (const n of deepTrace.graph.nodes) {
    const a = n.address.toLowerCase();
    if (!nodes.has(a)) {
      nodes.set(a, n);
    } else {
      const existing = nodes.get(a);
      // Upgrade type if deep trace found something more specific
      if (existing.type === "normal" || existing.type === "unknown") {
        if (["mixer", "cex", "bridge", "trail", "funding_source"].includes(n.type)) {
          existing.type = n.type;
        }
      }
      // Upgrade label if we found a better one
      if (n.label !== a.slice(0, 10) && existing.label === a.slice(0, 10)) {
        existing.label = n.label;
      }
      // Merge USD
      if (n.totalUsd > existing.totalUsd) existing.totalUsd = n.totalUsd;
      // Merge tokens
      if (n.tokens) {
        const tokenSet = new Set([...(existing.tokens || []), ...(n.tokens || [])]);
        existing.tokens = [...tokenSet];
      }
      // Add direction/hop info
      if (n.direction) existing.direction = n.direction;
      if (n.hop !== undefined) existing.hop = n.hop;
    }
  }

  // Add existing edges
  for (const e of existing.graph.edges) {
    const key = `${e.from}→${e.to}`;
    edges.set(key, { ...e });
  }

  // Merge deep trace edges
  for (const e of deepTrace.graph.edges) {
    const key = `${e.from}→${e.to}`;
    if (!edges.has(key)) {
      edges.set(key, e);
    } else {
      const ex = edges.get(key);
      if (e.totalUsd > ex.totalUsd) ex.totalUsd = e.totalUsd;
      if (e.totalEth > (ex.totalEth || 0)) ex.totalEth = e.totalEth;
      ex.isHot = ex.isHot || e.isHot;
      if (e.direction) ex.direction = e.direction;
      const tokenSet = new Set([...(ex.tokens || []), ...(e.tokens || [])]);
      ex.tokens = [...tokenSet];
    }
  }

  return {
    name: existing.name,
    graph: {
      nodes: [...nodes.values()],
      edges: [...edges.values()],
    },
    meta: deepTrace.meta,
  };
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log("Deep multi-hop fund flow tracing for all 7 hacks\n");
  console.log("=" .repeat(60));

  const allResults = [];

  for (const hack of HACKS) {
    try {
      const deepResult = await deepTrace(hack);

      // Load existing graph and merge
      const existingFile = `${CACHE_DIR}/${hack.id}.json`;
      let merged;
      if (existsSync(existingFile)) {
        const existing = JSON.parse(readFileSync(existingFile, "utf8"));
        merged = mergeGraphs(existing, deepResult);
      } else {
        merged = deepResult;
      }

      // Save merged result back
      writeFileSync(existingFile, JSON.stringify(merged, null, 2));
      allResults.push(merged);

      console.log(`  ✓ ${hack.name}: ${merged.graph.nodes.length} nodes, ${merged.graph.edges.length} edges`);
      if (deepResult.meta.mixers.length) console.log(`    Mixers: ${deepResult.meta.mixers.map(m => m.label).join(", ")}`);
      if (deepResult.meta.cexes.length) console.log(`    CEXes: ${deepResult.meta.cexes.map(c => c.label).join(", ")}`);
      if (deepResult.meta.bridges.length) console.log(`    Bridges: ${deepResult.meta.bridges.map(b => b.label).join(", ")}`);

    } catch (e) {
      console.error(`  ✗ ${hack.name}: ${e.message}`);
      console.error(e.stack?.split("\n").slice(0, 3).join("\n"));
    }
  }

  // Write combined file
  writeFileSync(`${CACHE_DIR}/all-graphs.json`, JSON.stringify(allResults, null, 2));

  // Final summary
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY\n");
  for (const r of allResults) {
    const types = {};
    r.graph.nodes.forEach(n => { types[n.type] = (types[n.type] || 0) + 1; });
    console.log(`${r.name}:`);
    console.log(`  Nodes: ${r.graph.nodes.length} ${JSON.stringify(types)}`);
    console.log(`  Edges: ${r.graph.edges.length}`);
    if (r.meta) {
      if (r.meta.mixers?.length) console.log(`  Mixers: ${r.meta.mixers.map(m => m.label).join(", ")}`);
      if (r.meta.cexes?.length) console.log(`  CEXes: ${r.meta.cexes.map(c => c.label).join(", ")}`);
      if (r.meta.bridges?.length) console.log(`  Bridges: ${r.meta.bridges.map(b => b.label).join(", ")}`);
    }
    console.log();
  }
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
