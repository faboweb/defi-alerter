/**
 * Build protocol infrastructure graphs from tx traces.
 *
 * For each hack:
 *   1. Trace baseline txs → extract protocol contract cluster
 *   2. Trace attack tx → extract attack call path
 *   3. Merge into a unified graph with labeled nodes and edges
 *   4. Classify: victim, attacker, protocol infra, external DeFi, token
 *
 * Uses Alchemy traces (cached from backtest) + Bitquery for fund flows.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";

const ALCHEMY_ETH = "https://eth-mainnet.g.alchemy.com/v2/Ov3ptXr915i4K30KHxATA";
const ALCHEMY_ARB = "https://arb-mainnet.g.alchemy.com/v2/Ov3ptXr915i4K30KHxATA";
const BITQUERY = "https://streaming.bitquery.io/graphql";
const BQ_TOKEN = "ory_at_ZzLD16N0_7u8Dk2thP8yYEuuvnxREIQhjDc2NIQAXHE.Mph0wK72aJvRqWDQMmCEUG9ZfBK9uJw34KGDQY2_5Ts";

const CACHE = "./graph-data";
const TRACE_DIRS = [
  "/Users/fabo/watchdog-backtest/cache-v5",
  "/Users/fabo/watchdog-backtest/cache-v5-all",
  "/Users/fabo/watchdog-backtest/cache-v4",
];

if (!existsSync(CACHE)) mkdirSync(CACHE);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── KNOWN CONTRACTS ───
const KNOWN = {
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
  "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
  "0x6b175474e89094c44da98b954eedeac495271d0f": "DAI",
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": "WBTC",
  "0x8236a87084f8b84306f72007f36f2618a5634494": "LBTC",
  "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": "wstETH",
  "0xf1c9acdc66974dfb6decb12aa385b9cd01190e38": "osETH",
  "0x18084fba666a33d37592fa2633fd49a74dd93a88": "tBTC",
  "0xbbbbbbbbbb9cc5e90e3b19a6d0b525f39a66d058": "Morpho",
  "0xbebc44782c7db0a1a60b1b98a6202171942db296": "Curve 3pool",
  "0xba12222222228d8ba445958a75a0704d566bf2c8": "Balancer Vault",
  "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": "Uniswap Router",
  "0x000000000022d473030f116ddee9f6b43ac78ba3": "Permit2",
  "0x489ee077994b6658eafa855c308275ead8097c4a": "GMX Vault",
  "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b": "Tornado Cash",
  "0x9008d19f58aabd9ed0d60971565aa8510560ab41": "CoW Protocol",
  "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae": "LiFi",
  "0x0000000000000000000000000000000000000000": "Null",
};

// ─── TRACE LOADING ───
function loadTrace(txHash) {
  for (const dir of TRACE_DIRS) {
    const f = `${dir}/trace_${txHash.slice(0, 18)}.json`;
    if (existsSync(f)) return JSON.parse(readFileSync(f));
  }
  return null;
}

async function fetchTrace(txHash, rpcUrl) {
  await sleep(100);
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "debug_traceTransaction", params: [txHash, { tracer: "callTracer", tracerConfig: { onlyTopCall: false } }], id: 1 }),
  });
  const d = await res.json();
  if (d.error) return null;
  // Cache it
  const f = `${TRACE_DIRS[0]}/trace_${txHash.slice(0, 18)}.json`;
  writeFileSync(f, JSON.stringify(d.result));
  return d.result;
}

// ─── EXTRACT GRAPH FROM TRACE ───
function extractGraph(trace) {
  const nodes = new Map();
  const edges = new Map();

  function walk(node, depth) {
    if (!node || depth > 20) return;
    const from = node.from?.toLowerCase();
    const to = node.to?.toLowerCase();
    const type = node.type || "CALL";
    const sig = node.input?.slice(0, 10) || "0x";
    const value = node.value ? parseInt(node.value, 16) / 1e18 : 0;

    if (from && to && to !== "0x0000000000000000000000000000000000000000") {
      // Nodes
      for (const addr of [from, to]) {
        if (!nodes.has(addr)) nodes.set(addr, { callCount: 0, calledBy: new Set(), callsTo: new Set(), sigs: new Set(), depths: new Set() });
        nodes.get(addr).callCount++;
      }
      nodes.get(to).calledBy.add(from);
      nodes.get(to).sigs.add(sig);
      nodes.get(to).depths.add(depth);
      nodes.get(from).callsTo.add(to);

      // Edges
      const key = `${from}→${to}`;
      if (!edges.has(key)) edges.set(key, { from, to, count: 0, types: new Set(), sigs: new Set(), totalValue: 0 });
      const e = edges.get(key);
      e.count++;
      e.types.add(type);
      e.sigs.add(sig);
      e.totalValue += value;
    }

    if (node.calls) node.calls.forEach(c => walk(c, depth + 1));
  }
  walk(trace, 0);
  return { nodes, edges };
}

// ─── BITQUERY TRANSFERS ───
async function bqTransfers(address, direction, network = "eth", limit = 25) {
  await sleep(600);
  const field = direction === "out" ? "Sender" : "Receiver";
  const res = await fetch(BITQUERY, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${BQ_TOKEN}` },
    body: JSON.stringify({ query: `{ EVM(network: ${network}, dataset: archive) { Transfers(where: {Transfer: {${field}: {is: "${address}"}}}, limit: {count: ${limit}}, orderBy: {ascending: Block_Number}) { Transfer { Amount AmountInUSD Currency { Symbol } Receiver Sender } } } }` }),
  });
  const d = await res.json();
  return d.data?.EVM?.Transfers || [];
}

// ─── BUILD PROTOCOL GRAPH ───
async function buildProtocolGraph(hack) {
  const cacheFile = `${CACHE}/${hack.id}.json`;
  if (existsSync(cacheFile)) {
    console.log(`  ${hack.name}: CACHED`);
    return JSON.parse(readFileSync(cacheFile));
  }

  console.log(`  ${hack.name}: building...`);

  // Step 1: Extract graph from attack tx trace
  let attackGraph = { nodes: new Map(), edges: new Map() };
  for (const txHash of hack.attackTxs) {
    let trace = loadTrace(txHash);
    if (!trace) {
      console.log(`    Fetching trace for ${txHash.slice(0, 18)}...`);
      trace = await fetchTrace(txHash, hack.rpcUrl);
    }
    if (trace) {
      const g = extractGraph(trace);
      // Merge
      g.nodes.forEach((v, k) => {
        if (!attackGraph.nodes.has(k)) attackGraph.nodes.set(k, v);
        else {
          const n = attackGraph.nodes.get(k);
          n.callCount += v.callCount;
          v.calledBy.forEach(a => n.calledBy.add(a));
          v.callsTo.forEach(a => n.callsTo.add(a));
          v.sigs.forEach(s => n.sigs.add(s));
        }
      });
      g.edges.forEach((v, k) => {
        if (!attackGraph.edges.has(k)) attackGraph.edges.set(k, v);
        else attackGraph.edges.get(k).count += v.count;
      });
      console.log(`    Attack trace: ${g.nodes.size} addresses, ${g.edges.size} call pairs`);
    }
  }

  // Step 2: Get fund flows from Bitquery
  const transfers = [];
  for (const addr of hack.attackerAddresses) {
    console.log(`    BQ outbound: ${addr.slice(0, 14)}`);
    transfers.push(...await bqTransfers(addr, "out", hack.network));
  }
  for (const addr of hack.attackerAddresses) {
    console.log(`    BQ inbound: ${addr.slice(0, 14)}`);
    transfers.push(...await bqTransfers(addr, "in", hack.network));
  }
  console.log(`    BQ victim in: ${hack.victimContract.slice(0, 14)}`);
  transfers.push(...await bqTransfers(hack.victimContract, "in", hack.network, 15));
  console.log(`    BQ victim out: ${hack.victimContract.slice(0, 14)}`);
  transfers.push(...await bqTransfers(hack.victimContract, "out", hack.network, 15));

  // Step 3: Build unified graph
  const victim = hack.victimContract.toLowerCase();
  const attackerSet = new Set(hack.attackerAddresses.map(a => a.toLowerCase()));

  // Classify nodes from trace
  const allNodes = new Map();
  const protocolAddrs = new Set();

  // Protocol cluster: 2-hop from victim in the call graph
  protocolAddrs.add(victim);
  const victimNode = attackGraph.nodes.get(victim);
  if (victimNode) {
    victimNode.calledBy.forEach(a => protocolAddrs.add(a));
    victimNode.callsTo.forEach(a => protocolAddrs.add(a));
  }
  for (const addr of [...protocolAddrs]) {
    const n = attackGraph.nodes.get(addr);
    if (n) {
      n.callsTo.forEach(a => protocolAddrs.add(a));
      n.calledBy.forEach(a => protocolAddrs.add(a));
    }
  }

  // Build output nodes
  attackGraph.nodes.forEach((data, addr) => {
    if (addr === "0x0000000000000000000000000000000000000000") return;

    const isVictim = addr === victim;
    const isAttacker = attackerSet.has(addr);
    const isKnown = KNOWN[addr];
    const isProtocol = protocolAddrs.has(addr) && !isAttacker;

    let type = "normal";
    if (isVictim) type = "victim";
    else if (isAttacker) type = "attacker";
    else if (isKnown) type = "defi";
    else if (isProtocol) type = "protocol";

    // Skip very low-activity normal nodes
    if (type === "normal" && data.callCount < 3) return;

    allNodes.set(addr, {
      address: addr,
      label: hack.labels[addr] || isKnown || addr.slice(0, 10),
      type,
      callCount: data.callCount,
      totalUsd: 0,
      tokens: [],
    });
  });

  // Add fund flow data from Bitquery transfers
  for (const t of transfers) {
    const sender = t.Transfer.Sender.toLowerCase();
    const receiver = t.Transfer.Receiver.toLowerCase();
    const usd = parseFloat(t.Transfer.AmountInUSD || 0);
    const sym = t.Transfer.Currency?.Symbol || "?";

    for (const addr of [sender, receiver]) {
      if (!allNodes.has(addr)) {
        const isAttacker = attackerSet.has(addr);
        allNodes.set(addr, {
          address: addr,
          label: hack.labels[addr] || KNOWN[addr] || addr.slice(0, 10),
          type: isAttacker ? "attacker" : "normal",
          callCount: 1,
          totalUsd: 0,
          tokens: [],
        });
      }
      const n = allNodes.get(addr);
      n.totalUsd += usd;
      if (!n.tokens.includes(sym)) n.tokens.push(sym);
    }
  }

  // Propagate trail: anything that receives from attacker
  const queue = [...attackerSet].filter(a => allNodes.has(a));
  const visited = new Set(queue);
  const transferEdges = new Map();

  for (const t of transfers) {
    const s = t.Transfer.Sender.toLowerCase();
    const r = t.Transfer.Receiver.toLowerCase();
    const key = `${s}→${r}`;
    const usd = parseFloat(t.Transfer.AmountInUSD || 0);
    if (!transferEdges.has(key)) transferEdges.set(key, { from: s, to: r, totalUsd: 0, count: 0, tokens: new Set() });
    const e = transferEdges.get(key);
    e.totalUsd += usd;
    e.count++;
    e.tokens.add(t.Transfer.Currency?.Symbol || "?");
  }

  while (queue.length) {
    const addr = queue.shift();
    transferEdges.forEach(e => {
      if (e.from === addr && !visited.has(e.to) && e.totalUsd > 100) {
        visited.add(e.to);
        const n = allNodes.get(e.to);
        if (n && n.type === "normal") n.type = "trail";
        queue.push(e.to);
      }
    });
  }

  // Build call edges (from trace) — only between nodes we're keeping
  const callEdges = [];
  attackGraph.edges.forEach((data, key) => {
    if (allNodes.has(data.from) && allNodes.has(data.to)) {
      const fromNode = allNodes.get(data.from);
      const toNode = allNodes.get(data.to);
      const isHot = fromNode.type === "attacker" || toNode.type === "attacker" ||
                    fromNode.type === "trail" || toNode.type === "trail";
      callEdges.push({
        from: data.from,
        to: data.to,
        totalUsd: 0,
        count: data.count,
        tokens: [],
        edgeType: "call",
        isHot,
      });
    }
  });

  // Build transfer edges
  const fundEdges = [];
  transferEdges.forEach(e => {
    if (allNodes.has(e.from) && allNodes.has(e.to)) {
      fundEdges.push({
        from: e.from,
        to: e.to,
        totalUsd: e.totalUsd,
        count: e.count,
        tokens: [...e.tokens],
        edgeType: "transfer",
        isHot: allNodes.get(e.from)?.type === "attacker" || allNodes.get(e.to)?.type === "attacker" ||
               allNodes.get(e.from)?.type === "trail" || allNodes.get(e.to)?.type === "trail",
      });
    }
  });

  // Merge edges — prefer transfer edges (they have USD), add call-only edges
  const finalEdges = new Map();
  for (const e of fundEdges) {
    finalEdges.set(`${e.from}→${e.to}`, e);
  }
  for (const e of callEdges) {
    const key = `${e.from}→${e.to}`;
    if (!finalEdges.has(key)) finalEdges.set(key, e);
  }

  const result = {
    name: hack.name,
    graph: {
      nodes: [...allNodes.values()],
      edges: [...finalEdges.values()],
    },
  };

  const types = {};
  result.graph.nodes.forEach(n => { types[n.type] = (types[n.type] || 0) + 1; });
  console.log(`    Result: ${result.graph.nodes.length} nodes ${JSON.stringify(types)}, ${result.graph.edges.length} edges`);

  writeFileSync(cacheFile, JSON.stringify(result, null, 2));
  return result;
}

// ─── HACKS ───
const HACKS = [
  {
    id: "balancer-v2", name: "Balancer V2", network: "eth", rpcUrl: ALCHEMY_ETH,
    victimContract: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
    attackerAddresses: ["0x506d1f9efe24f0d47853adca907eb8d89ae03207", "0xAa760D53541d8390074c61DEFeaba314675b8e3f"],
    attackTxs: ["0x6ed07db1a9fe5c0794d44cd36081d6a6df103fab868cdd75d581e3bd23bc9742", "0xd155207261712c35fa3d472ed1e51bfcd816e616dd4f517fa5959836f5b48569"],
    labels: { "0x506d1f9efe24f0d47853adca907eb8d89ae03207": "ATTACKER: Deployer", "0xaa760d53541d8390074c61defeaba314675b8e3f": "ATTACKER: Recipient", "0xba12222222228d8ba445958a75a0704d566bf2c8": "Balancer Vault" },
  },
  {
    id: "gmx-v1", name: "GMX V1", network: "arbitrum", rpcUrl: ALCHEMY_ARB,
    victimContract: "0x489ee077994b6658eafa855c308275ead8097c4a",
    attackerAddresses: ["0xd4266f8f82f7405429ee18559e548979d49160f3", "0x7D3BD50336f64b7a473c51f54e7f0bd6771cc355"],
    attackTxs: ["0x03182d3f0956a91c4e4c8f225bbc7975f9434fab042228c7acdc5ec9a32626ef"],
    labels: { "0xd4266f8f82f7405429ee18559e548979d49160f3": "ATTACKER: EOA", "0x7d3bd50336f64b7a473c51f54e7f0bd6771cc355": "ATTACKER: Contract", "0x489ee077994b6658eafa855c308275ead8097c4a": "GMX Vault" },
  },
  {
    id: "verus-bridge", name: "Verus Bridge", network: "eth", rpcUrl: ALCHEMY_ETH,
    victimContract: "0x71518580f36feceffe0721f06ba4703218cd7f63",
    attackerAddresses: ["0x5aBb91B9c01A5Ed3aE762d32B236595B459D5777", "0x65Cb8b128Bf6e690761044CCECA422bb239C25F9"],
    attackTxs: ["0x6990f01720f57fc515d0e976a0c4f8157e0a9529194c4c15d190e98d087eb321"],
    labels: { "0x5abb91b9c01a5ed3ae762d32b236595b459d5777": "ATTACKER: EOA", "0x65cb8b128bf6e690761044cceca422bb239c25f9": "ATTACKER: Consolidation", "0x71518580f36feceffe0721f06ba4703218cd7f63": "Verus Bridge" },
  },
  {
    id: "makina-finance", name: "Makina Finance", network: "eth", rpcUrl: ALCHEMY_ETH,
    victimContract: "0x32E616F4f17d43f9A5cd9Be0e294727187064cb3",
    attackerAddresses: ["0x935bfb495E33f74d2E9735DF1DA66acE442ede48"],
    attackTxs: ["0x569733b8016ef9418f0b6bde8c14224d9e759e79301499908ecbcd956a0651f5"],
    labels: { "0x935bfb495e33f74d2e9735df1da66ace442ede48": "ATTACKER: EOA", "0x32e616f4f17d43f9a5cd9be0e294727187064cb3": "DUSD Pool" },
  },
  {
    id: "crosscurve", name: "CrossCurve", network: "eth", rpcUrl: ALCHEMY_ETH,
    victimContract: "0xAc8f44ceCa92b2a4b30360E5bd3043850a0FFcbE",
    attackerAddresses: ["0x632400f42e96a5deb547a179ca46b02c22cd25cd"],
    attackTxs: ["0x37d9b911ef710be851a2e08e1cfc61c2544db0f208faeade29ee98cc7506ccc2"],
    labels: { "0x632400f42e96a5deb547a179ca46b02c22cd25cd": "ATTACKER: EOA", "0xac8f44ceca92b2a4b30360e5bd3043850a0ffcbe": "PortalV2" },
  },
  {
    id: "nmt-module", name: "NMT Module", network: "eth", rpcUrl: ALCHEMY_ETH,
    victimContract: "0x1f1d37a3Bf840e35c6a860c7c2dA71Fe555123ca",
    attackerAddresses: ["0x7c82cb4b2909c50c7c0f2b696eee7565e0a23bb8", "0x577fe2ff999ebd166fbbe21eb121ec413bbdbd3f"],
    attackTxs: ["0x220e1beaf7f5d1e009f303a043f4bcd9caec1daa6cca11c547aaf48ec9954843"],
    labels: { "0x7c82cb4b2909c50c7c0f2b696eee7565e0a23bb8": "ATTACKER: EOA 1", "0x577fe2ff999ebd166fbbe21eb121ec413bbdbd3f": "ATTACKER: EOA 2", "0x1f1d37a3bf840e35c6a860c7c2da71fe555123ca": "SquidRouter Module" },
  },
  {
    id: "cork-protocol", name: "Cork Protocol", network: "eth", rpcUrl: ALCHEMY_ETH,
    victimContract: "0xCCd90F6435dd78C4ECCED1FA4db0D7242548a2a9",
    attackerAddresses: ["0xea6f30e360192bae715599e15e2f765b49e4da98"],
    attackTxs: ["0xfd89cdd0be468a564dd525b222b728386d7c6780cf7b2f90d2b54493be09f64d"],
    labels: { "0xea6f30e360192bae715599e15e2f765b49e4da98": "ATTACKER: EOA", "0xccd90f6435dd78c4ecced1fa4db0d7242548a2a9": "Cork Vault" },
  },
];

async function main() {
  console.log("Building protocol infrastructure graphs\n");
  const results = [];

  for (const hack of HACKS) {
    try {
      results.push(await buildProtocolGraph(hack));
    } catch (e) {
      console.error(`  ${hack.name}: ERROR — ${e.message}`);
    }
  }

  writeFileSync(`${CACHE}/all-graphs.json`, JSON.stringify(results, null, 2));
  console.log(`\nDone. ${results.length} graphs saved.`);
  results.forEach(r => {
    const types = {};
    r.graph.nodes.forEach(n => { types[n.type] = (types[n.type] || 0) + 1; });
    console.log(`  ${r.name}: ${r.graph.nodes.length} nodes ${JSON.stringify(types)}, ${r.graph.edges.length} edges`);
  });
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
