/**
 * Fetch real on-chain fund flow graphs for all 7 hacks via Bitquery V2.
 * Outputs cached JSON for the website to render.
 *
 * For each hack:
 *   1. Trace attacker outbound (hop 1-2)
 *   2. Get protocol infra (transfers to/from victim contract)
 *   3. Build graph nodes + edges with real addresses, amounts, tokens
 */

import { writeFileSync, existsSync, readFileSync } from "fs";

const BITQUERY = "https://streaming.bitquery.io/graphql";
const TOKEN = "ory_at_ZzLD16N0_7u8Dk2thP8yYEuuvnxREIQhjDc2NIQAXHE.Mph0wK72aJvRqWDQMmCEUG9ZfBK9uJw34KGDQY2_5Ts";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function query(q) {
  await sleep(500); // rate limit
  const res = await fetch(BITQUERY, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
    body: JSON.stringify({ query: q }),
  });
  const d = await res.json();
  if (d.errors) { console.error("  GQL Error:", JSON.stringify(d.errors).slice(0, 200)); return []; }
  return d.data?.EVM?.Transfers || [];
}

async function getOutboundTransfers(address, network = "eth", limit = 30) {
  return query(`{
    EVM(network: ${network}, dataset: archive) {
      Transfers(
        where: {Transfer: {Sender: {is: "${address}"}}}
        limit: {count: ${limit}}
        orderBy: {ascending: Block_Number}
      ) {
        Transfer { Amount AmountInUSD Currency { Symbol Name } Receiver Sender }
        Block { Number Time }
        Transaction { Hash From To }
      }
    }
  }`);
}

async function getInboundTransfers(address, network = "eth", limit = 30) {
  return query(`{
    EVM(network: ${network}, dataset: archive) {
      Transfers(
        where: {Transfer: {Receiver: {is: "${address}"}}}
        limit: {count: ${limit}}
        orderBy: {descending: Block_Number}
      ) {
        Transfer { Amount AmountInUSD Currency { Symbol Name } Receiver Sender }
        Block { Number Time }
        Transaction { Hash From To }
      }
    }
  }`);
}

function buildGraph(transfers, knownLabels = {}) {
  const nodes = new Map();
  const edges = new Map();

  for (const t of transfers) {
    const sender = t.Transfer.Sender.toLowerCase();
    const receiver = t.Transfer.Receiver.toLowerCase();
    const sym = t.Transfer.Currency?.Symbol || "?";
    const usd = parseFloat(t.Transfer.AmountInUSD || 0);
    const amount = parseFloat(t.Transfer.Amount || 0);

    // Nodes
    for (const addr of [sender, receiver]) {
      if (!nodes.has(addr)) {
        nodes.set(addr, {
          address: addr,
          label: knownLabels[addr] || addr.slice(0, 10),
          totalUsd: 0,
          txCount: 0,
          tokens: new Set(),
          type: knownLabels[addr]?.includes("ATTACKER") ? "attacker" :
                knownLabels[addr]?.includes("VICTIM") ? "victim" : "normal",
        });
      }
    }

    const sNode = nodes.get(sender);
    const rNode = nodes.get(receiver);
    sNode.txCount++;
    rNode.txCount++;
    sNode.totalUsd += usd;
    sNode.tokens.add(sym);
    rNode.tokens.add(sym);

    // Edges
    const key = `${sender}→${receiver}`;
    if (!edges.has(key)) {
      edges.set(key, { from: sender, to: receiver, totalUsd: 0, count: 0, tokens: new Set() });
    }
    const edge = edges.get(key);
    edge.totalUsd += usd;
    edge.count++;
    edge.tokens.add(sym);
  }

  // Convert to serializable
  return {
    nodes: [...nodes.values()].map(n => ({ ...n, tokens: [...n.tokens] })),
    edges: [...edges.values()].map(e => ({ ...e, tokens: [...e.tokens] })),
  };
}

// ─── HACKS TO TRACE ───
const HACKS = [
  {
    name: "Balancer V2",
    network: "eth",
    attackerAddresses: [
      "0x506d1f9efe24f0d47853adca907eb8d89ae03207",
      "0xAa760D53541d8390074c61DEFeaba314675b8e3f",
    ],
    victimContract: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
    labels: {
      "0x506d1f9efe24f0d47853adca907eb8d89ae03207": "ATTACKER: Deployer",
      "0xaa760d53541d8390074c61defeaba314675b8e3f": "ATTACKER: Recipient",
      "0xba12222222228d8ba445958a75a0704d566bf2c8": "VICTIM: Balancer Vault",
      "0x54b53503c0e2173df29f8da735fbd45ee8aba30d": "ATTACKER: Exploit Contract",
    },
  },
  {
    name: "GMX V1",
    network: "arbitrum",
    attackerAddresses: [
      "0xd4266f8f82f7405429ee18559e548979d49160f3",
      "0x7D3BD50336f64b7a473c51f54e7f0bd6771cc355",
    ],
    victimContract: "0x489ee077994b6658eafa855c308275ead8097c4a",
    labels: {
      "0xd4266f8f82f7405429ee18559e548979d49160f3": "ATTACKER: EOA",
      "0x7d3bd50336f64b7a473c51f54e7f0bd6771cc355": "ATTACKER: Contract",
      "0x489ee077994b6658eafa855c308275ead8097c4a": "VICTIM: GMX Vault",
    },
  },
  {
    name: "Verus Bridge",
    network: "eth",
    attackerAddresses: [
      "0x5aBb91B9c01A5Ed3aE762d32B236595B459D5777",
      "0x65Cb8b128Bf6e690761044CCECA422bb239C25F9",
    ],
    victimContract: "0x71518580f36feceffe0721f06ba4703218cd7f63",
    labels: {
      "0x5abb91b9c01a5ed3ae762d32b236595b459d5777": "ATTACKER: EOA",
      "0x65cb8b128bf6e690761044cceca422bb239c25f9": "ATTACKER: Consolidation",
      "0x71518580f36feceffe0721f06ba4703218cd7f63": "VICTIM: Verus Bridge",
    },
  },
  {
    name: "Makina Finance",
    network: "eth",
    attackerAddresses: ["0x935bfb495E33f74d2E9735DF1DA66acE442ede48"],
    victimContract: "0x32E616F4f17d43f9A5cd9Be0e294727187064cb3",
    labels: {
      "0x935bfb495e33f74d2e9735df1da66ace442ede48": "ATTACKER: EOA",
      "0x32e616f4f17d43f9a5cd9be0e294727187064cb3": "VICTIM: DUSD/USDC Pool",
    },
  },
  {
    name: "CrossCurve",
    network: "eth",
    attackerAddresses: ["0x632400f42e96a5deb547a179ca46b02c22cd25cd"],
    victimContract: "0xAc8f44ceCa92b2a4b30360E5bd3043850a0FFcbE",
    labels: {
      "0x632400f42e96a5deb547a179ca46b02c22cd25cd": "ATTACKER: EOA",
      "0xac8f44ceca92b2a4b30360e5bd3043850a0ffcbe": "VICTIM: PortalV2",
    },
  },
  {
    name: "NMT Module",
    network: "eth",
    attackerAddresses: [
      "0x7c82cb4b2909c50c7c0f2b696eee7565e0a23bb8",
      "0x577fe2ff999ebd166fbbe21eb121ec413bbdbd3f",
    ],
    victimContract: "0x1f1d37a3Bf840e35c6a860c7c2dA71Fe555123ca",
    labels: {
      "0x7c82cb4b2909c50c7c0f2b696eee7565e0a23bb8": "ATTACKER: EOA 1",
      "0x577fe2ff999ebd166fbbe21eb121ec413bbdbd3f": "ATTACKER: EOA 2",
      "0x1f1d37a3bf840e35c6a860c7c2da71fe555123ca": "VICTIM: SquidRouterModule",
      "0xfac7459683cdb9b6f367b42eedfebd745dc8760c": "ATTACKER: Token U",
    },
  },
  {
    name: "Cork Protocol",
    network: "eth",
    attackerAddresses: ["0xea6f30e360192bae715599e15e2f765b49e4da98"],
    victimContract: "0xCCd90F6435dd78C4ECCED1FA4db0D7242548a2a9",
    labels: {
      "0xea6f30e360192bae715599e15e2f765b49e4da98": "ATTACKER: EOA",
      "0xccd90f6435dd78c4ecced1fa4db0d7242548a2a9": "VICTIM: Cork Vault",
    },
  },
];

async function traceHack(hack) {
  const cacheFile = `graph-data/${hack.name.replace(/\s+/g, '-').toLowerCase()}.json`;
  if (existsSync(cacheFile)) {
    console.log(`  ${hack.name}: CACHED`);
    return JSON.parse(readFileSync(cacheFile, "utf8"));
  }

  console.log(`  ${hack.name}: fetching...`);
  const allTransfers = [];

  // 1. Attacker outbound (hop 1)
  for (const addr of hack.attackerAddresses) {
    console.log(`    Attacker outbound: ${addr.slice(0, 14)}`);
    const transfers = await getOutboundTransfers(addr, hack.network);
    allTransfers.push(...transfers);
    console.log(`      → ${transfers.length} transfers`);

    // 2. Hop 2: for top receivers, get THEIR outbound
    const receivers = [...new Set(transfers
      .map(t => t.Transfer.Receiver.toLowerCase())
      .filter(r => r !== "0x0000000000000000000000000000000000000000")
    )].slice(0, 5);

    for (const recv of receivers) {
      console.log(`    Hop 2: ${recv.slice(0, 14)}`);
      const hop2 = await getOutboundTransfers(recv, hack.network, 15);
      allTransfers.push(...hop2);
      console.log(`      → ${hop2.length} transfers`);
    }
  }

  // 3. Protocol infra: inbound to victim
  console.log(`    Victim inbound: ${hack.victimContract.slice(0, 14)}`);
  const inbound = await getInboundTransfers(hack.victimContract, hack.network, 20);
  allTransfers.push(...inbound);
  console.log(`      → ${inbound.length} transfers`);

  // 4. Victim outbound
  console.log(`    Victim outbound: ${hack.victimContract.slice(0, 14)}`);
  const outbound = await getOutboundTransfers(hack.victimContract, hack.network, 20);
  allTransfers.push(...outbound);
  console.log(`      → ${outbound.length} transfers`);

  // Build graph
  const graph = buildGraph(allTransfers, Object.fromEntries(
    Object.entries(hack.labels).map(([k, v]) => [k.toLowerCase(), v])
  ));

  console.log(`    Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

  // Cache
  const result = { name: hack.name, graph, transferCount: allTransfers.length };
  writeFileSync(cacheFile, JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  // Ensure cache dir
  if (!existsSync("graph-data")) {
    const { mkdirSync } = await import("fs");
    mkdirSync("graph-data");
  }

  console.log("Fetching real on-chain fund flow graphs via Bitquery V2\n");

  const results = [];
  for (const hack of HACKS) {
    try {
      const result = await traceHack(hack);
      results.push(result);
    } catch (e) {
      console.error(`  ${hack.name}: ERROR — ${e.message}`);
    }
  }

  // Write combined file for the website
  writeFileSync("graph-data/all-graphs.json", JSON.stringify(results, null, 2));
  console.log(`\nDone. ${results.length} graphs saved to graph-data/`);

  // Summary
  for (const r of results) {
    console.log(`  ${r.name}: ${r.graph.nodes.length} nodes, ${r.graph.edges.length} edges, ${r.transferCount} transfers`);
  }
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
