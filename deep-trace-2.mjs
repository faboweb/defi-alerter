/**
 * Deep trace pass 2: Follow the largest unresolved trail nodes
 * from pass 1 to find their ultimate destinations.
 *
 * Focus on:
 *  - Balancer: 5 massive trail nodes (159K ETH)
 *  - GMX: trail nodes on Arbitrum
 *  - Verus: 4K ETH trail
 *  - NMT: unresolved trails
 *  - Cork: deeper hop on 4.5K ETH nodes
 */

import { writeFileSync, readFileSync, existsSync } from "fs";

const ALCHEMY_ETH = "https://eth-mainnet.g.alchemy.com/v2/Ov3ptXr915i4K30KHxATA";
const ALCHEMY_ARB = "https://arb-mainnet.g.alchemy.com/v2/Ov3ptXr915i4K30KHxATA";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Known addresses (same as deep-trace.mjs — key sinks)
const KNOWN = {
  "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b": { label: "Tornado Cash Router", type: "mixer" },
  "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc": { label: "Tornado Cash 0.1 ETH", type: "mixer" },
  "0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936": { label: "Tornado Cash 1 ETH", type: "mixer" },
  "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf": { label: "Tornado Cash 10 ETH", type: "mixer" },
  "0xa160cdab225685da1d56aa342ad8841c3b53f291": { label: "Tornado Cash 100 ETH", type: "mixer" },
  "0x722122df12d4e14e13ac3b6895a86e84145b6967": { label: "Tornado Cash Proxy", type: "mixer" },
  "0xfd8610d20aa15b7b2e3be39b396a1bc3516c7144": { label: "Tornado Cash 100 ETH (2)", type: "mixer" },
  "0x0836222f2b2b24a3f36f98668ed8f0b38d1a872f": { label: "Tornado Cash 0.1 ETH (3)", type: "mixer" },
  "0xba214c1c1928a32bffe790263e38b4af9bfcd659": { label: "Tornado Cash 1000 DAI", type: "mixer" },
  "0xd4b88df4d29f5cedd6857912842cff3b20c8cfa3": { label: "Tornado Cash 100 DAI", type: "mixer" },
  "0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9": { label: "Railgun", type: "mixer" },
  "0x28c6c06298d514db089934071355e5743bf21d60": { label: "Binance 14", type: "cex" },
  "0x21a31ee1afc51d94c2efccaa2092ad1028285549": { label: "Binance 15", type: "cex" },
  "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": { label: "Binance 16", type: "cex" },
  "0x56eddb7aa87536c09ccc2793473599fd21a8b17f": { label: "Binance 17", type: "cex" },
  "0xf977814e90da44bfa03b6295a0616a897441acec": { label: "Binance 8", type: "cex" },
  "0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be": { label: "Binance 1", type: "cex" },
  "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": { label: "Coinbase 1", type: "cex" },
  "0x503828976d22510aad0201ac7ec88293211d23da": { label: "Coinbase 2", type: "cex" },
  "0x2910543af39aba0cd09dbb2d50200b3e800a63d2": { label: "Kraken 1", type: "cex" },
  "0x0a869d79a7052c7f1b55a8ebabbea3420f0d1e13": { label: "Kraken 2", type: "cex" },
  "0xe853c56864a2ebe4576a807d26fdc4a0ada51919": { label: "Kraken 3", type: "cex" },
  "0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0": { label: "Kraken 4", type: "cex" },
  "0x6cc5f688a315f3dc28a7781717a9a798a59fda7b": { label: "OKX 1", type: "cex" },
  "0x236f9f97e0e62388479bf9e5ba4889e46b0273c3": { label: "OKX 2", type: "cex" },
  "0xf89d7b9c864f589bbf53a82105107622b35eaa40": { label: "Bybit 1", type: "cex" },
  "0x1db92e2eebc8e0c075a02bea49a2935bcd2dfcf4": { label: "Bybit 2", type: "cex" },
  "0xf16e9b0d03470827a95cdfd0cb8a8a3b46969b91": { label: "KuCoin 1", type: "cex" },
  "0xab5c66752a9e8167967685f1450532fb96d5d24f": { label: "Huobi 1", type: "cex" },
  "0x4e5b2e1dc63f6b91cb6cd759936495434c7e972f": { label: "FixedFloat", type: "cex" },
  "0xb8547d4822f5e8042e55e50f31fd1de1133f4951": { label: "eXch", type: "cex" },
  "0xedbb69ba82f00b10f6dd9e15e76e8c93c6e5103c": { label: "eXch Hot", type: "cex" },
  "0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146": { label: "THORChain Router 4", type: "bridge" },
  "0x2dccdb493827e15a5dc8f8b72147e6c4a5620857": { label: "THORChain Router", type: "bridge" },
  "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae": { label: "LiFi", type: "bridge" },
  "0x3a23f943181408eac424116af7b7790c94cb97a5": { label: "Socket Gateway", type: "bridge" },
  "0x2796317b0ff8538f253012862c06787adfb8ceb6": { label: "Synapse Bridge", type: "bridge" },
  "0x4c36d2919e407f0cc2ee3c993ccf8ac26d9ce64e": { label: "Across Bridge V2", type: "bridge" },
  "0x5427fefa711eff984124bfbb1ab6fbf5e3da1820": { label: "Across Bridge V3", type: "bridge" },
  "0x6571d6be3d8460cf5f7d6711cd9961860029d85f": { label: "Across SpokePool", type: "bridge" },
  "0xe4edb277e41dc89ab076a1f049f4a3efa700bce8": { label: "Orbiter Finance", type: "bridge" },
  "0x3ee18b2214aff97000d974cf647e7c347e8fa585": { label: "Wormhole", type: "bridge" },
  "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1": { label: "Optimism Bridge", type: "bridge" },
  "0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f": { label: "Arbitrum Bridge", type: "bridge" },
  "0x0000000000000000000000000000000000000000": { label: "Null", type: "null" },
};

const KNOWN_SET = new Map(Object.entries(KNOWN).map(([k, v]) => [k.toLowerCase(), v]));

async function getTransfers(rpcUrl, address, direction, maxCount = 50) {
  await sleep(200);
  const isArb = rpcUrl.includes("arb-");
  const params = {
    category: isArb ? ["external", "erc20"] : ["external", "internal", "erc20"],
    maxCount: `0x${maxCount.toString(16)}`,
    withMetadata: true,
    excludeZeroValue: true,
  };
  if (direction === "out") params.fromAddress = address;
  else params.toAddress = address;

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "alchemy_getAssetTransfers", params: [params], id: 1 }),
  });
  const d = await res.json();
  if (d.error) { console.error(`    Alchemy error: ${d.error.message}`); return []; }
  return d.result?.transfers || [];
}

// Targets to trace: hack → [address, label, expectedEth]
const TARGETS = [
  // Balancer V2 — massive unresolved trails (staging wallets that distributed to sub-wallets)
  { hack: "balancer-v2", rpcUrl: ALCHEMY_ETH, addresses: [
    "0xa6d63a745edf07edac5fb2e5f1be1c8456d16a5f",  // 86K ETH
    "0xa6d623b871d80b49836a8bddd39fa2a01e7f3fb0",  // 28K ETH
    "0xb01c9f79342d98f7fd55cf0e832b0dbab6f1d092",  // 17.8K ETH
    "0x1c7da4e9740f8b0d30e7601e56c5fc9fd7b5b677",  // 14K ETH
    "0xb973e729cb2224e3d6d89407f19f0f19f7f7c73e",  // 14K ETH
  ]},
  // Verus Bridge — main consolidation wallets
  { hack: "verus-bridge", rpcUrl: ALCHEMY_ETH, addresses: [
    "0xf9ab28cb7b7257e50b9b9e08e48c0cd46b88ffbe",  // 4K ETH
    "0xa8d38bb2562da2fb67d9feeed444bd6c4b25d55f",  // 2.7K ETH
    "0xa8d3662af2fc5eee7937e41a53c4cd30af982fbb",  // 1.35K ETH
    "0xa8df8bda357556c69a3a37af8ceab44f9c93f9c2",  // 1.35K ETH
  ]},
  // GMX V1 — Arbitrum trail nodes
  { hack: "gmx-v1", rpcUrl: ALCHEMY_ARB, addresses: [
    "0xdf3340a436c2c77bd6d5f0a73bbe61a18dcc9bec",  // 3.2K ETH
    "0x4e971a87900b931ff39d1aad67697f49835400b6",  // large AVAX trail
    "0x1addd80e6039b017eaf7ec18e72d3dcf01e8a84a",  // another large one
    "0xc6962004f452be9203591991d15f6b388e09e8d0",  // 7.5M
  ]},
  // NMT Module — staging wallets
  { hack: "nmt-module", rpcUrl: ALCHEMY_ETH, addresses: [
    "0x7c8ee77632124e4ae0afdc0ba1f9adcc66d04a1f",  // 2K ETH
    "0xa447f71782135abd98bf40cc5d78d02c9e2b5c6d",  // 1.36K ETH
    "0xe12e0f117d2356a0f3e7618e1f78bc7c65c71a0f",  // 180 ETH
  ]},
  // Cork Protocol — main staging wallets
  { hack: "cork-protocol", rpcUrl: ALCHEMY_ETH, addresses: [
    "0xfc0a6de0abd06707d94dfde0de53d5ba2e5c8fe4",  // 4.5K ETH
    "0xfc0aa44fe8d2e02a7fcbdde3be5f1e6a0e3e8bb3",  // 4.5K ETH
    "0x778de20162bd0aa13c6e2d3cc07c8f26daa7cf45",  // 3.2K ETH
    "0x778dc2cf3c2ef25ef7d9e58d39b39d3e4f2bd3b0",  // 2.8K ETH
  ]},
];

async function traceTarget(target) {
  console.log(`\n━━━ ${target.hack} ━━━`);
  const discoveries = [];

  for (const addr of target.addresses) {
    const a = addr.toLowerCase();
    console.log(`  Tracing ${a.slice(0, 14)}...`);

    const outbound = await getTransfers(target.rpcUrl, a, "out", 100);
    console.log(`    → ${outbound.length} outbound transfers`);

    const destinations = new Map();

    for (const tx of outbound) {
      const to = tx.to?.toLowerCase();
      if (!to || to === a) continue;
      const val = parseFloat(tx.value || 0);
      const eth = (tx.asset === "ETH" || tx.asset === "WETH") ? val : 0;

      if (!destinations.has(to)) destinations.set(to, { eth: 0, usd: 0, tokens: new Set(), count: 0 });
      const d = destinations.get(to);
      d.eth += eth;
      d.usd += eth * 2500;
      d.count++;
      if (tx.asset) d.tokens.add(tx.asset);
    }

    // Report and trace further
    const sorted = [...destinations.entries()].sort((a, b) => b[1].eth - a[1].eth);

    for (const [dest, info] of sorted.slice(0, 10)) {
      const known = KNOWN_SET.get(dest);
      const tag = known ? `[${known.type.toUpperCase()}] ${known.label}` : dest.slice(0, 14);

      if (info.eth > 0.1 || info.usd > 100) {
        console.log(`    → ${tag.padEnd(40)} ${info.eth.toFixed(1).padStart(10)} ETH  (${info.count} txs)  ${[...info.tokens].join(',')}`);
      }

      if (known) {
        discoveries.push({ from: a, to: dest, label: known.label, type: known.type, eth: info.eth, tokens: [...info.tokens] });
        continue;
      }

      // Hop 2 for unknown destinations with significant value
      if (info.eth > 10) {
        const hop2out = await getTransfers(target.rpcUrl, dest, "out", 50);
        const hop2dests = new Map();

        for (const tx of hop2out) {
          const to2 = tx.to?.toLowerCase();
          if (!to2 || to2 === dest) continue;
          const val = parseFloat(tx.value || 0);
          const eth2 = (tx.asset === "ETH" || tx.asset === "WETH") ? val : 0;

          if (!hop2dests.has(to2)) hop2dests.set(to2, { eth: 0, tokens: new Set(), count: 0 });
          const d = hop2dests.get(to2);
          d.eth += eth2;
          d.count++;
          if (tx.asset) d.tokens.add(tx.asset);
        }

        const hop2sorted = [...hop2dests.entries()].sort((a, b) => b[1].eth - a[1].eth);
        for (const [dest2, info2] of hop2sorted.slice(0, 5)) {
          const known2 = KNOWN_SET.get(dest2);
          if (known2 && info2.eth > 0.1) {
            console.log(`      → → [${known2.type.toUpperCase()}] ${known2.label.padEnd(30)} ${info2.eth.toFixed(1).padStart(10)} ETH`);
            discoveries.push({ from: dest, to: dest2, label: known2.label, type: known2.type, eth: info2.eth, via: a, tokens: [...info2.tokens] });
          } else if (info2.eth > 50) {
            console.log(`      → → ${dest2.slice(0, 14).padEnd(40)} ${info2.eth.toFixed(1).padStart(10)} ETH`);

            // Hop 3 for really large unknowns
            if (info2.eth > 100) {
              const hop3out = await getTransfers(target.rpcUrl, dest2, "out", 30);
              for (const tx of hop3out) {
                const to3 = tx.to?.toLowerCase();
                if (!to3) continue;
                const known3 = KNOWN_SET.get(to3);
                const eth3 = (tx.asset === "ETH" || tx.asset === "WETH") ? parseFloat(tx.value || 0) : 0;
                if (known3 && eth3 > 0.1) {
                  console.log(`        → → → [${known3.type.toUpperCase()}] ${known3.label.padEnd(25)} ${eth3.toFixed(1).padStart(10)} ETH`);
                  discoveries.push({ from: dest2, to: to3, label: known3.label, type: known3.type, eth: eth3, tokens: [tx.asset] });
                }
              }
            }
          }
        }
      }
    }
  }

  console.log(`\n  DISCOVERIES for ${target.hack}:`);
  const byType = {};
  for (const d of discoveries) {
    if (!byType[d.type]) byType[d.type] = [];
    byType[d.type].push(d);
  }
  for (const [type, items] of Object.entries(byType)) {
    const totalEth = items.reduce((s, i) => s + i.eth, 0);
    console.log(`    ${type.toUpperCase()}: ${totalEth.toFixed(1)} ETH across ${items.length} flows`);
    items.sort((a, b) => b.eth - a.eth);
    items.slice(0, 5).forEach(d => {
      console.log(`      ${d.label}: ${d.eth.toFixed(1)} ETH`);
    });
  }

  return discoveries;
}

async function main() {
  console.log("Deep trace pass 2: Following unresolved trail nodes\n");
  const allDiscoveries = {};

  for (const target of TARGETS) {
    try {
      allDiscoveries[target.hack] = await traceTarget(target);
    } catch (e) {
      console.error(`  ERROR ${target.hack}: ${e.message}`);
    }
  }

  // Save discoveries
  writeFileSync("graph-data/trace-cache/pass2-discoveries.json", JSON.stringify(allDiscoveries, null, 2));

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("OVERALL SUMMARY\n");
  for (const [hack, discoveries] of Object.entries(allDiscoveries)) {
    const mixerEth = discoveries.filter(d => d.type === 'mixer').reduce((s, d) => s + d.eth, 0);
    const cexEth = discoveries.filter(d => d.type === 'cex').reduce((s, d) => s + d.eth, 0);
    const bridgeEth = discoveries.filter(d => d.type === 'bridge').reduce((s, d) => s + d.eth, 0);
    console.log(`${hack}:`);
    if (mixerEth) console.log(`  Mixer: ${mixerEth.toFixed(1)} ETH ($${Math.round(mixerEth * 2500).toLocaleString()})`);
    if (cexEth) console.log(`  CEX: ${cexEth.toFixed(1)} ETH ($${Math.round(cexEth * 2500).toLocaleString()})`);
    if (bridgeEth) console.log(`  Bridge: ${bridgeEth.toFixed(1)} ETH ($${Math.round(bridgeEth * 2500).toLocaleString()})`);
    if (!mixerEth && !cexEth && !bridgeEth) console.log(`  No sinks found yet`);
  }
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
