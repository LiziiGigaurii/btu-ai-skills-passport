/*
 * BTU AI Skills Digital Passport: Polygon (Amoy test network) connection.
 *
 * - Writing: the administrator's wallet (MetaMask) signs ONE transaction per batch,
 *   registering every new passport version in contracts/PassportRegistry.sol.
 *   No private key is stored in the website or the repository.
 * - Reading: anyone (no wallet, no login) checks a PDF hash or a verification code
 *   against the contract through the public Polygon RPC.
 * - Only hashes go on-chain: SHA-256 of the PDF, keccak256 of the verification code
 *   and keccak256 of the Passport ID. No names, e-mails or skills.
 *
 * Dependency-free: Keccak-256 and the ABI encoding for the few calls we need are
 * implemented here.
 */
(function (root) {
  "use strict";

  // ------------------------------------------------------------------ settings
  // Set CONTRACT after deploying the contract (README: "Polygon"). The administrator can
  // also set it in the browser (Blockchain page); that value wins in that browser.
  const DEFAULTS = {
    CONTRACT: "0x0fa0455d0249fe8d18f93cfb7b8ddc9d95acf3a1",
    ISSUER: "0xB6454f2CD62853f8604FF47A2672900c8Fe8D2FA", // BTU wallet address that deployed the contract (published in BTU's DID document)
  };
  const NETWORK = {
    chainId: 80002,
    chainIdHex: "0x13882",
    name: "Polygon Amoy",
    // Public RPC endpoints, tried in order. (rpc-amoy.polygon.technology refuses browser
    // requests from other websites, so it is only the last resort and MetaMask's fallback.)
    rpcs: ["https://polygon-amoy-bor-rpc.publicnode.com", "https://polygon-amoy.drpc.org", "https://polygon-amoy.gateway.tenderly.co", "https://rpc-amoy.polygon.technology"],
    explorer: "https://amoy.polygonscan.com",
    currency: { name: "POL", symbol: "POL", decimals: 18 },
  };
  const LS = "btu-ap-chain-v1";
  function settings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(LS) || "{}") || {}; } catch (e) { s = {}; }
    return { contract: (s.contract || DEFAULTS.CONTRACT || "").trim(), issuer: (s.issuer || DEFAULTS.ISSUER || "").trim() };
  }
  function saveSettings(s) {
    try { localStorage.setItem(LS, JSON.stringify({ contract: (s.contract || "").trim(), issuer: (s.issuer || "").trim() })); } catch (e) {}
  }
  const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));

  // ---------------------------------------------------------------- Keccak-256
  const RC = [
    "0000000000000001", "0000000000008082", "800000000000808a", "8000000080008000", "000000000000808b", "0000000080000001",
    "8000000080008081", "8000000000008009", "000000000000008a", "0000000000000088", "0000000080008009", "000000008000000a",
    "000000008000808b", "800000000000008b", "8000000000008089", "8000000000008003", "8000000000008002", "8000000000000080",
    "000000000000800a", "800000008000000a", "8000000080008081", "8000000000008080", "0000000080000001", "8000000080008008",
  ].map((h) => BigInt("0x" + h));
  const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
  const M64 = (1n << 64n) - 1n;
  const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);
  function keccakF(s) {
    for (let round = 0; round < 24; round++) {
      const C = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
      for (let x = 0; x < 5; x++) {
        const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
        for (let y = 0; y < 25; y += 5) s[x + y] ^= D;
      }
      const B = new Array(25);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) s[x + y] = B[x + y] ^ (~B[(x + 1) % 5 + y] & M64 & B[(x + 2) % 5 + y]);
      s[0] ^= RC[round];
    }
  }
  function keccak256(input) {
    const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
    const rate = 136;
    const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
    padded.set(bytes);
    padded[bytes.length] ^= 0x01;
    padded[padded.length - 1] ^= 0x80;
    const s = new Array(25).fill(0n);
    for (let off = 0; off < padded.length; off += rate) {
      for (let i = 0; i < rate / 8; i++) {
        let lane = 0n;
        for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
        s[i] ^= lane;
      }
      keccakF(s);
    }
    let out = "";
    for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out += Number((s[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, "0");
    return "0x" + out;
  }

  // ----------------------------------------------------------------------- ABI
  const strip = (h) => String(h).replace(/^0x/, "").toLowerCase();
  const word = (hex) => strip(hex).padStart(64, "0");
  const uintWord = (n) => BigInt(n).toString(16).padStart(64, "0");
  const selector = (sig) => keccak256(sig).slice(0, 10);
  const SIG = {
    issueBatch: "issueBatch(bytes32[],bytes32[],bytes32[],uint32[])",
    verify: "verify(bytes32)",
    verifyCode: "verifyCode(bytes32)",
    issuer: "issuer()",
  };
  // f(bytes32[] a, bytes32[] b, bytes32[] c, uint32[] d): four offsets, then each array as length + items.
  function encodeIssueBatch(docHashes, codeHashes, refs, versions) {
    const arrays = [docHashes.map(word), codeHashes.map(word), refs.map(word), versions.map(uintWord)];
    let offset = 32 * arrays.length, head = "", tail = "";
    for (const a of arrays) {
      head += uintWord(offset);
      const enc = uintWord(a.length) + a.join("");
      tail += enc;
      offset += enc.length / 2;
    }
    return selector(SIG.issueBatch) + head + tail;
  }
  const decodeWords = (hex) => strip(hex).match(/.{64}/g) || [];
  function decodeVerify(hex) {
    const w = decodeWords(hex);
    if (w.length < 6) return { issued: false };
    return {
      issued: BigInt("0x" + w[0]) === 1n,
      isLatest: BigInt("0x" + w[1]) === 1n,
      ref: "0x" + w[2],
      version: Number(BigInt("0x" + w[3])),
      issuedAt: Number(BigInt("0x" + w[4])),
      issuedBy: "0x" + w[5].slice(24),
    };
  }

  // ---------------------------------------------------------------- read (RPC)
  let rpcId = 0, good = 0;
  async function rpc(method, params) {
    let last = null;
    for (let k = 0; k < NETWORK.rpcs.length; k++) {
      const i = (good + k) % NETWORK.rpcs.length;
      try {
        const r = await fetch(NETWORK.rpcs[i], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        if (j.error) { if (/execution reverted/i.test(j.error.message || "")) throw Object.assign(new Error(j.error.message), { fatal: true }); throw new Error(j.error.message || j.error.code); }
        good = i;
        return j.result;
      } catch (e) { last = e; if (e.fatal) break; }
    }
    throw new Error("Polygon RPC: " + (last ? last.message : "unreachable"));
  }
  const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
  const sha256Hex = (h) => "0x" + strip(h);
  const passportRef = (pid) => keccak256(String(pid));
  const codeHash = (code) => keccak256(String(code).trim().toUpperCase());

  function configured() { return isAddress(settings().contract); }
  async function verifyDoc(docSha256) {
    const c = settings().contract;
    if (!isAddress(c)) return null;
    const res = decodeVerify(await call(c, selector(SIG.verify) + word(sha256Hex(docSha256))));
    return Object.assign(res, { contract: c });
  }
  async function verifyCodeOnChain(code) {
    const c = settings().contract;
    if (!isAddress(c)) return null;
    const res = decodeVerify(await call(c, selector(SIG.verifyCode) + word(codeHash(code))));
    // verifyCode returns the document hash in the third slot
    return Object.assign(res, { docHash: res.ref, contract: c });
  }
  async function issuerOf(contract) {
    const r = await call(contract || settings().contract, selector(SIG.issuer));
    return "0x" + strip(r).slice(-40);
  }
  async function receipt(tx) { return rpc("eth_getTransactionReceipt", [tx]); }

  // ------------------------------------------------------------- write (wallet)
  const wallet = () => root.ethereum || null;
  async function connect() {
    const eth = wallet();
    if (!eth) throw new Error("NO_WALLET");
    const [account] = await eth.request({ method: "eth_requestAccounts" });
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: NETWORK.chainIdHex }] });
    } catch (e) {
      if (e && (e.code === 4902 || /Unrecognized chain/i.test(e.message || ""))) {
        await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: NETWORK.chainIdHex, chainName: NETWORK.name, rpcUrls: NETWORK.rpcs, blockExplorerUrls: [NETWORK.explorer], nativeCurrency: NETWORK.currency }] });
      } else throw e;
    }
    return account;
  }
  // items: [{ docHash (sha-256 hex), code, passportId, version (number) }], oldest first.
  async function issueBatch(items) {
    const c = settings().contract;
    if (!isAddress(c)) throw new Error("NO_CONTRACT");
    const from = await connect();
    const data = encodeIssueBatch(items.map((x) => sha256Hex(x.docHash)), items.map((x) => codeHash(x.code)), items.map((x) => passportRef(x.passportId)), items.map((x) => x.version));
    const tx = await wallet().request({ method: "eth_sendTransaction", params: [Object.assign({ from, to: c, data }, await fees())] });
    return { tx, from };
  }
  // Polygon rejects transactions whose priority fee ("tip") is below 25 gwei, but wallets often
  // propose less. Set the fees explicitly: tip 30 gwei, max fee = 1.5 x current base fee + tip.
  const GWEI = 1000000000n;
  async function fees() {
    const tip = 30n * GWEI;
    let base = 0n;
    try {
      const b = await rpc("eth_getBlockByNumber", ["latest", false]);
      base = BigInt((b && b.baseFeePerGas) || 0);
    } catch (e) {
      try {
        const b = await wallet().request({ method: "eth_getBlockByNumber", params: ["latest", false] });
        base = BigInt((b && b.baseFeePerGas) || 0);
      } catch (e2) {}
    }
    const hex = (n) => "0x" + n.toString(16);
    return { maxPriorityFeePerGas: hex(tip), maxFeePerGas: hex(base + base / 2n + tip + 5n * GWEI) };
  }
  async function waitForReceipt(tx, timeoutMs) {
    const end = Date.now() + (timeoutMs || 120000);
    while (Date.now() < end) {
      const r = await receipt(tx).catch(() => null);
      if (r && r.blockNumber) return { ok: r.status === "0x1", block: parseInt(r.blockNumber, 16) };
      await new Promise((ok) => setTimeout(ok, 2500));
    }
    throw new Error("TIMEOUT");
  }

  const links = {
    tx: (h) => NETWORK.explorer + "/tx/" + h,
    address: (a) => NETWORK.explorer + "/address/" + a,
  };

  root.Chain = {
    NETWORK, settings, saveSettings, isAddress, configured, hasWallet: () => !!wallet(),
    keccak256, selector, encodeIssueBatch, decodeVerify, passportRef, codeHash,
    verifyDoc, verifyCode: verifyCodeOnChain, issuerOf, connect, issueBatch, waitForReceipt, links,
  };
})(typeof window !== "undefined" ? window : globalThis);
