const fs = require('fs');
const path = require('path');
const maxmind = require('maxmind');

// =============================================
// RIR 国家列表（覆盖所有主权国家与地区）
// =============================================

const RIPE_COUNTRIES = [
  "DE","GB","FR","NL","BE","LU","IE","PT","ES","IT","MT","CH","AT","LI","MC","AD",
  "SE","NO","DK","FI","IS","EE","LV","LT","GL",
  "PL","CZ","SK","HU","RO","BG","HR","SI","BA","RS","ME","MK","AL","GR",
  "RU","UA","BY","MD","GE","AM","AZ","KZ","UZ","TM","KG","TJ",
  "TR","IL","AE","SA","QA","KW","BH","OM","YE","JO","LB","SY","IQ","IR",
  "EG","LY","TN","DZ","MA","MR","SD",
  "NG","GH","CI","SN","CM","ML","BF","NE","TD","GN","SL","LR","TG","BJ","GW","GM","CV",
  "ZA","ZW","ZM","MZ","BW","NA","LS","SZ","AO","MW","MG","MU","SC","KM","ST",
  "ET","KE","TZ","UG","RW","BI","SO","DJ","ER","SS",
  "CD","CG","GA","GQ","CF",
  "XK",
];

const APNIC_COUNTRIES = [
  "CN","JP","KR","AU","SG","HK","TW","MO","MN",
  "MY","TH","VN","ID","PH","MM","KH","LA","BN","TL",
  "IN","BD","LK","NP","BT","MV",
  "NZ","PG","FJ","SB","VU","WS","TO","KI","FM","PW","MH","NR","TV","CK",
  "PK","AF",
];

const LACNIC_COUNTRIES = [
  "BR","AR","CL","CO","PE","VE","EC","BO","PY","UY","GY","SR",
  "MX","GT","BZ","HN","SV","NI","CR","PA",
  "CU","JM","HT","DO","TT","BB","LC","VC","GD","AG","DM","KN","BS",
  "PR",
];

const ARIN_COUNTRIES = ["US","CA"];

const AFRINIC_COUNTRIES = [];

const ALL_COUNTRIES = [...new Set([
  ...RIPE_COUNTRIES, ...APNIC_COUNTRIES, ...LACNIC_COUNTRIES,
  ...ARIN_COUNTRIES, ...AFRINIC_COUNTRIES,
])];

const TERRITORIES_FALLBACK = {
  "PR": ["66.98.224.0/21","209.6.0.0/18","64.125.0.0/19"],
  "GU": ["168.123.0.0/18","202.128.0.0/17"],
  "VI": ["208.84.136.0/22"],
};

const XK_HARDCODED = ["217.198.64.1", "77.74.64.1", "188.120.148.1"];

// =============================================
// 工具函数
// =============================================

function isPublicIP(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(x => isNaN(x) || x < 0 || x > 255)) return false;
  const [a, b, c] = p;
  if (a === 0) return false;
  if (a === 10) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function addOffset(ip, offset) {
  if (!ip) return null;
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(isNaN)) return null;
  let n = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  n = (n + offset) >>> 0;
  const r = `${(n>>>24)&255}.${(n>>>16)&255}.${(n>>>8)&255}.${n&255}`;
  return isPublicIP(r) ? r : null;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// =============================================
// 解析 delegated 文件
// =============================================

function parseDelegatedFile(text, targetCountries) {
  const pool = {};
  const targetSet = new Set(targetCountries);
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const p = trimmed.split("|");
    if (p.length < 7) continue;
    if (p[1] === "*") continue;
    if (p[2] !== "ipv4") continue;
    const status = p[6]?.split("#")[0].trim();
    if (status === "summary") continue;

    const cc = p[1]?.toUpperCase();
    const startIP = p[3];
    const count = parseInt(p[4]) || 0;

    if (!cc || cc.length !== 2) continue;
    if (!targetSet.has(cc)) continue;
    if (!isPublicIP(startIP)) continue;
    if (count < 256) continue;

    if (!pool[cc]) pool[cc] = [];
    if (pool[cc].length < 50) {
      pool[cc].push({ startIP, count });
    }
  }
  return pool;
}

function sampleFromBlocks(blocks, n) {
  const ips = [];
  const step = Math.max(1, Math.floor(blocks.length / n));
  for (let i = 0; i < blocks.length && ips.length < n; i += step) {
    const { startIP, count } = blocks[i];
    const offset = Math.min(Math.floor(count / 2), 100);
    const ip = addOffset(startIP, offset);
    if (ip) ips.push(ip);
  }
  return ips;
}

// =============================================
// MaxMind 本地验证
// =============================================

let lookupDb = null;
async function initMaxMind() {
  if (!lookupDb) {
    const dbPath = path.join(process.cwd(), 'data', 'GeoLite2-Country.mmdb');
    lookupDb = await maxmind.open(dbPath);
  }
  return lookupDb;
}

async function verifyWithMaxMind(ipList) {
  const db = await initMaxMind();
  const result = {};
  for (const ip of ipList) {
    try {
      const geo = db.get(ip);
      if (geo?.country?.iso_code) {
        result[ip] = geo.country.iso_code.toUpperCase();
      }
    } catch (e) { /* ignore */ }
  }
  return result;
}

// =============================================
// mra8-api 单 IP 查询
// =============================================

async function queryMRA8(ip) {
  try {
    const resp = await fetch(`https://mra8-api.hf.space/${ip}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.country?.code?.toUpperCase() || null;
  } catch (e) {
    return null;
  }
}

// =============================================
// 从 RIPE 缓存中提取 XK 大量候选 IP
// =============================================

function getXKCandidatesFromRIPE() {
  const ripeText = RIR_RAW_TEXT["RIPE"];
  if (!ripeText) return [];
  const ips = [];
  const lines = ripeText.split('\n');
  for (const line of lines) {
    if (line.startsWith('#') || line.trim() === '') continue;
    const p = line.split('|');
    if (p.length < 7 || p[1] !== "XK" || p[2] !== "ipv4") continue;
    const status = p[6]?.split('#')[0].trim();
    if (status === "summary") continue;
    const startIP = p[3];
    const count = parseInt(p[4]) || 0;
    if (!isPublicIP(startIP) || count < 256) continue;
    const first = addOffset(startIP, 1);
    const mid = addOffset(startIP, Math.floor(count / 2));
    const last = addOffset(startIP, count - 2);
    for (const ip of [first, mid, last]) {
      if (ip && !ips.includes(ip)) ips.push(ip);
    }
  }
  return ips.slice(0, 30);
}

// =============================================
// 自动 Bypass：从已缓存的 RIR 原始文本提取 IP
// =============================================

let RIR_RAW_TEXT = {};

function getAutoBypassIPs(cc) {
  const ips = [];
  for (const [rir, text] of Object.entries(RIR_RAW_TEXT)) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('#') || line.trim() === '') continue;
      const p = line.split('|');
      if (p.length < 7 || p[1] !== cc || p[2] !== "ipv4") continue;
      const status = p[6]?.split('#')[0].trim();
      if (status === "summary") continue;
      const startIP = p[3];
      const count = parseInt(p[4]) || 0;
      if (!isPublicIP(startIP) || count < 8) continue;
      const mid = addOffset(startIP, Math.floor(count / 2));
      if (mid && !ips.includes(mid)) ips.push(mid);
    }
  }
  return [...new Set(ips)].slice(0, 5);
}

function getTerritoryFallbackIPs(cc) {
  const prefixes = TERRITORIES_FALLBACK[cc] || [];
  const ips = [];
  for (const pfx of prefixes) {
    const [base, bits] = pfx.split('/');
    const size = Math.pow(2, 32 - parseInt(bits));
    const ip = addOffset(base, Math.floor(size / 2));
    if (ip) ips.push(ip);
  }
  return ips;
}

// =============================================
// 抓取 RIR 候选
// =============================================

async function fetchFromRIR(url, targetCountries, name) {
  console.log(`[${name}] 抓取中...`);
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(60000),
      headers: { "User-Agent": "GH-IPCollector/5.0" },
    });
    if (!resp.ok) {
      console.log(`[${name}] HTTP ${resp.status}`);
      return { candidates: {}, raw: null };
    }
    const text = await resp.text();
    console.log(`[${name}] ${(text.length / 1024).toFixed(0)} KB`);
    RIR_RAW_TEXT[name] = text;
    const pool = parseDelegatedFile(text, targetCountries);
    console.log(`[${name}] ${Object.keys(pool).length} 个国家`);
    const candidates = {};
    for (const [cc, blocks] of Object.entries(pool)) {
      const ips = sampleFromBlocks(blocks, 8);
      if (ips.length > 0) candidates[cc] = ips;
    }
    return { candidates, raw: text };
  } catch (e) {
    console.error(`[${name}] 错误:`, e.message);
    return { candidates: {}, raw: null };
  }
}

// =============================================
// 验证流程（批量 MaxMind）
// =============================================

async function verifyIPs(candidates, label = "") {
  const allIPs = [];
  const ipToCC = {};
  for (const [cc, ips] of Object.entries(candidates)) {
    for (const ip of ips) {
      if (!allIPs.includes(ip)) {
        allIPs.push(ip);
        ipToCC[ip] = cc;
      }
    }
  }
  if (allIPs.length === 0) return {};
  console.log(`[Verify${label}] 共 ${allIPs.length} 个IP待验证...`);

  const verified = {};
  const batches = chunk(allIPs, 100);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`[Verify${label}] 批次 ${i + 1}/${batches.length} (${batch.length}个IP)...`);
    const result = await verifyWithMaxMind(batch);
    for (const [ip, actualCC] of Object.entries(result)) {
      const expectedCC = ipToCC[ip];
      if (actualCC === expectedCC) {
        if (!verified[actualCC]) verified[actualCC] = [];
        if (verified[actualCC].length < 10) verified[actualCC].push(ip);
      } else {
        console.log(`[Verify${label}] ❌ ${ip}: 期望${expectedCC} 实际${actualCC}`);
      }
    }
  }
  return verified;
}

// =============================================
// 构建最终数据
// =============================================

function seededShuffle(arr, seed) {
  const a = [...arr];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildFinal(verified) {
  const out = {};
  const today = new Date();
  const ds = today.getUTCFullYear() * 10000 +
             (today.getUTCMonth() + 1) * 100 +
             today.getUTCDate();

  for (const [cc, ips] of Object.entries(verified)) {
    if (!ips?.length) continue;
    const valid = ips.filter(isPublicIP);
    if (!valid.length) continue;
    const seed = ds + cc.charCodeAt(0) * 31 + (cc.charCodeAt(1) || 0) * 17;
    const shuffled = seededShuffle(valid, seed);
    const take = Math.min(shuffled.length, Math.max(2, 2 + (seed % 3)));
    out[cc] = shuffled.slice(0, take);
  }
  return out;
}

// =============================================
// 主流程
// =============================================

async function main() {
  console.log("=== IP数据库更新开始 ===");
  const start = Date.now();
  await initMaxMind();

  // Step 1: 抓取各 RIR
  console.log("\n--- Step 1: 抓取各 RIR 候选IP ---");
  const rirFetchers = [
    fetchFromRIR("https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-latest",
                 RIPE_COUNTRIES, "RIPE"),
    fetchFromRIR("https://ftp.apnic.net/stats/apnic/delegated-apnic-latest",
                 APNIC_COUNTRIES, "APNIC"),
    fetchFromRIR("https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-latest",
                 LACNIC_COUNTRIES, "LACNIC"),
    fetchFromRIR("https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest",
                 ARIN_COUNTRIES, "ARIN"),
    fetchFromRIR("https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-latest",
                 AFRINIC_COUNTRIES, "AFRINIC").catch(e => {
                   console.log('[AFRINIC] 抓取失败，将跳过');
                   return { candidates: {}, raw: null };
                 }),
  ];

  const rirResults = await Promise.all(rirFetchers);

  // 合并候选
  const allCandidates = {};
  for (const { candidates } of rirResults) {
    for (const [cc, ips] of Object.entries(candidates)) {
      if (!allCandidates[cc]) allCandidates[cc] = [];
      for (const ip of ips) {
        if (allCandidates[cc].length < 15 && !allCandidates[cc].includes(ip)) {
          allCandidates[cc].push(ip);
        }
      }
    }
  }

  const totalCandidates = Object.values(allCandidates).reduce((s, a) => s + a.length, 0);
  console.log(`\n候选汇总: ${Object.keys(allCandidates).length} 国, ${totalCandidates} 个IP待验证`);

  // Step 2: MaxMind 验证
  console.log("\n--- Step 2: MaxMind 验证 ---");
  const verified = await verifyIPs(allCandidates);
  console.log(`验证通过: ${Object.keys(verified).length} 个国家`);

  // Step 3: 自动 Bypass 并二次验证（仅丢弃明确错误的国家代码）
  let missing = ALL_COUNTRIES.filter(cc => !verified[cc]);
  for (const cc of Object.keys(TERRITORIES_FALLBACK)) {
    if (!verified[cc]) missing.push(cc);
  }
  missing = [...new Set(missing)];

  if (missing.length > 0) {
    console.log(`\n--- Step 3: 自动 Bypass 处理 (${missing.length} 国) ---`);
    for (const cc of missing) {
      let bypassIPs = getAutoBypassIPs(cc);
      if (bypassIPs.length === 0) {
        bypassIPs = getTerritoryFallbackIPs(cc);
      }
      if (bypassIPs.length === 0 && cc === "XK") {
        bypassIPs = XK_HARDCODED.filter(isPublicIP);
      }

      // 二次验证：仅当 API 明确返回不同国家时才丢弃
      if (bypassIPs.length > 0) {
        const confirmedIPs = [];
        for (const ip of bypassIPs) {
          const apiCountry = await queryMRA8(ip);
          if (apiCountry === null) {
            // API 无结果，信任 RIR 来源，保留
            confirmedIPs.push(ip);
          } else if (apiCountry === cc) {
            confirmedIPs.push(ip);
          } else {
            console.log(`[BYPASS] 🔍 ${cc} ${ip} 实际归属 ${apiCountry}，丢弃`);
          }
        }
        bypassIPs = confirmedIPs;
      }

      // 科索沃特殊扫描：如果仍为空，尝试从 RIPE 大量候选
      if (cc === "XK" && bypassIPs.length === 0) {
        console.log("[BYPASS] XK 所有候选均未通过，启动增强扫描...");
        const candidates = getXKCandidatesFromRIPE();
        const found = [];
        for (const ip of candidates) {
          const apiCountry = await queryMRA8(ip);
          if (apiCountry === "XK") {
            found.push(ip);
            console.log(`[BYPASS] XK 找到有效IP: ${ip}`);
            if (found.length >= 2) break;
          }
        }
        bypassIPs = found;
      }

      if (bypassIPs.length > 0) {
        verified[cc] = bypassIPs;
        console.log(`[BYPASS] ${cc}: ${bypassIPs.join(', ')}`);
      } else {
        console.log(`[BYPASS] ${cc}: ❌ 无法获取任何有效IP，该地区将缺失`);
      }
    }
  }

  // Step 4: 构建最终数据
  console.log("\n--- Step 4: 构建最终数据 ---");
  const final = buildFinal(verified);

  const covered = Object.keys(final).length;
  const totalExpected = ALL_COUNTRIES.length;
  const finalMissing = ALL_COUNTRIES.filter(cc => !final[cc]);

  console.log(`\n覆盖率: ${covered}/${totalExpected}`);
  if (finalMissing.length > 0) {
    console.log(`⚠️ 未覆盖: ${finalMissing.join(", ")}`);
  }

  // 抽查
  console.log("\n--- 验证抽查 ---");
  const checkList = ["CN","US","MN","JP","DE","BR","ZA","SC","JM","PR","BB","BS","XK"];
  for (const cc of checkList) {
    const ips = final[cc];
    console.log(`${cc}: ${ips ? ips.join(", ") : "❌ 无数据"}`);
  }

  // 写入文件
  const payload = {
    ips: final,
    updated_at: new Date().toISOString(),
    source: "rir-delegated-files + maxmind-geolite2 + mra8-api-verification",
    country_count: covered,
    coverage_rate: `${covered}/${totalExpected}`,
    missing: finalMissing,
  };

  const outputDir = path.join(process.cwd(), "data");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "ip-database.json");
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n=== 完成！${covered}/${totalExpected} 国，耗时 ${elapsed}s ===`);
}

main().catch(e => {
  console.error("致命错误:", e);
  process.exit(1);
});
