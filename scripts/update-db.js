// scripts/update-db.js
const fs = require('fs');
const path = require('path');

const RIPE_COUNTRIES = [
  "DE","GB","FR","NL","BE","LU","IE","PT","ES","IT","MT","CH","AT","LI","MC","AD",
  "SE","NO","DK","FI","IS","EE","LV","LT","GL",
  "PL","CZ","SK","HU","RO","BG","HR","SI","BA","RS","ME","MK","AL","GR","XK",
  "RU","UA","BY","MD","GE","AM","AZ","KZ","UZ","TM","KG","TJ",
  "TR","IL","AE","SA","QA","KW","BH","OM","YE","JO","LB","SY","IQ","IR",
  "EG","LY","TN","DZ","MA","MR","SD",
  "NG","GH","CI","SN","CM","ML","BF","NE","TD","GN","SL","LR","TG","BJ","GW","GM","CV",
  "ZA","ZW","ZM","MZ","BW","NA","LS","SZ","AO","MW","MG","MU","SC","KM","ST",
  "ET","KE","TZ","UG","RW","BI","SO","DJ","ER","SS",
  "CD","CG","GA","GQ","CF",
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
  "CU","JM","HT","DO","PR","TT","BB","LC","VC","GD","AG","DM","KN","BS",
];

const ARIN_COUNTRIES = ["US","CA"];

const ALL_COUNTRIES = [...new Set([
  ...RIPE_COUNTRIES, ...APNIC_COUNTRIES, ...LACNIC_COUNTRIES, ...ARIN_COUNTRIES
])];

// 已知这些国家的 RIR 注册IP与实际地理位置经常不符
// 需要使用专门的已知可靠IP或扩大候选范围
// 格式: cc -> 从权威来源手工确认的真实IP段起始地址（用于生成候选）
const KNOWN_RELIABLE = {
  // 科索沃：使用 IPVS/本地ISP已知段
  "XK": ["77.74.64.1","188.120.148.1","91.193.202.1","89.248.184.1"],
  // 塞舌尔：SeyTel 运营商真实段
  "SC": ["196.56.0.1","196.57.0.1","196.58.0.1","41.220.236.1","105.235.192.1"],
  // 加勒比小国（来自 LACNIC delegated 的真实分配段）
  "JM": ["72.35.22.1","38.87.240.1","168.7.252.1","200.55.128.1"],
  "PR": ["23.24.20.1","38.88.0.1","66.151.12.1","96.29.160.1"],
  "BB": ["196.24.45.1","200.32.0.1","206.214.248.1"],
  "LC": ["192.203.154.1","205.147.112.1","216.152.130.1"],
  "VC": ["192.203.157.1","209.234.232.1"],
  "GD": ["192.203.152.1","209.234.175.1"],
  "AG": ["192.203.156.1","205.147.116.1"],
  "DM": ["192.203.153.1","216.152.136.1"],
  "KN": ["192.203.155.1","209.234.176.1"],
  "BS": ["199.200.16.1","199.212.102.1","204.13.144.1"],
};

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
// ip-api.com 批量验证
// =============================================
async function verifyWithIPAPI(ipList) {
  const url = "http://ip-api.com/batch?fields=query,countryCode,status";
  const body = ipList.map(ip => ({ query: ip, fields: "query,countryCode,status" }));
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "GH-IPCollector/4.1" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) { console.log(`[ip-api] HTTP ${resp.status}`); return {}; }
    const data = await resp.json();
    const result = {};
    for (const item of data) {
      if (item.status === "success" && item.countryCode && item.query) {
        result[item.query] = item.countryCode.toUpperCase();
      }
    }
    return result;
  } catch (e) {
    console.log(`[ip-api] 错误: ${e.message}`);
    return {};
  }
}

// 验证一批候选，返回 { cc -> [verified ips] }
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
    const result = await verifyWithIPAPI(batch);

    for (const [ip, actualCC] of Object.entries(result)) {
      const expectedCC = ipToCC[ip];
      if (actualCC === expectedCC) {
        if (!verified[actualCC]) verified[actualCC] = [];
        if (verified[actualCC].length < 10) verified[actualCC].push(ip);
      } else {
        console.log(`[Verify${label}] ❌ ${ip}: 期望${expectedCC} 实际${actualCC}`);
      }
    }

    if (i < batches.length - 1) await sleep(1500);
  }
  return verified;
}

// =============================================
// 抓取 RIR 候选
// =============================================
async function fetchFromRIR(url, targetCountries, name) {
  console.log(`[${name}] 抓取中...`);
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(60000),
      headers: { "User-Agent": "GH-IPCollector/4.1" },
    });
    if (!resp.ok) { console.log(`[${name}] HTTP ${resp.status}`); return {}; }
    const text = await resp.text();
    console.log(`[${name}] ${(text.length / 1024).toFixed(0)} KB`);
    const pool = parseDelegatedFile(text, targetCountries);
    console.log(`[${name}] ${Object.keys(pool).length} 个国家`);
    const candidates = {};
    for (const [cc, blocks] of Object.entries(pool)) {
      // 每国取8个候选（增加命中率）
      const ips = sampleFromBlocks(blocks, 8);
      if (ips.length > 0) candidates[cc] = ips;
    }
    return candidates;
  } catch (e) {
    console.error(`[${name}] 错误:`, e.message);
    return {};
  }
}

async function fetchRIPEByAPI() {
  console.log('[RIPE] 逐国抓取前缀...');
  const candidates = {};
  const batches = chunk(RIPE_COUNTRIES, 8);

  for (const batch of batches) {
    await Promise.all(batch.map(async (cc) => {
      try {
        const resp = await fetch(
          `https://stat.ripe.net/data/country-resource-list/data.json?resource=${cc}&v=4`,
          {
            signal: AbortSignal.timeout(10000),
            headers: { "Accept": "application/json", "User-Agent": "GH-IPCollector/4.1" },
          }
        );
        if (!resp.ok) return;
        const json = await resp.json();
        const prefixes = json?.data?.resources?.ipv4;
        if (!Array.isArray(prefixes) || prefixes.length === 0) return;

        const step = Math.max(1, Math.floor(prefixes.length / 8));
        const ips = [];
        for (let i = 0; i < prefixes.length && ips.length < 8; i += step) {
          const prefix = typeof prefixes[i] === 'string' ? prefixes[i] : prefixes[i]?.prefix;
          if (!prefix) continue;
          const [base, bits] = prefix.split("/");
          const size = bits ? Math.pow(2, 32 - parseInt(bits)) : 256;
          const offset = Math.min(Math.floor(size / 2), 100);
          const ip = addOffset(base, offset);
          if (ip) ips.push(ip);
        }
        if (ips.length > 0) candidates[cc] = ips;
      } catch (e) { /* 忽略单国失败 */ }
    }));
    await sleep(200);
  }
  console.log(`[RIPE] ${Object.keys(candidates).length} 个国家`);
  return candidates;
}

// =============================================
// 对缺失国家做深度搜索
// =============================================

// 方案A：扩大偏移量，从同一段取更多候选IP重试
function expandCandidates(originalCandidates, moreOffsets) {
  const expanded = {};
  for (const [cc, ips] of Object.entries(originalCandidates)) {
    const extras = [];
    for (const ip of ips) {
      for (const offset of moreOffsets) {
        const newIP = addOffset(ip, offset);
        if (newIP && !ips.includes(newIP) && !extras.includes(newIP)) {
          extras.push(newIP);
        }
      }
    }
    if (extras.length > 0) expanded[cc] = extras;
  }
  return expanded;
}

// 方案B：使用 KNOWN_RELIABLE 已知可靠IP
function getKnownReliableCandidates(missingCCs) {
  const candidates = {};
  for (const cc of missingCCs) {
    if (KNOWN_RELIABLE[cc]) {
      // 对每个已知IP生成多个偏移候选
      const ips = [];
      for (const base of KNOWN_RELIABLE[cc]) {
        for (const offset of [1, 10, 50, 100, 200]) {
          const ip = addOffset(base, offset);
          if (ip) ips.push(ip);
        }
      }
      if (ips.length > 0) candidates[cc] = ips;
    }
  }
  return candidates;
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

  // Step 1: 抓取 RIR 候选
  console.log("\n--- Step 1: 抓取各 RIR 候选IP ---");
  const [ripeCandidates, apnicCandidates, lacnicCandidates, arinCandidates] = await Promise.all([
    fetchRIPEByAPI(),
    fetchFromRIR("https://ftp.apnic.net/stats/apnic/delegated-apnic-latest", APNIC_COUNTRIES, "APNIC"),
    fetchFromRIR("https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-latest", LACNIC_COUNTRIES, "LACNIC"),
    fetchFromRIR("https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest", ARIN_COUNTRIES, "ARIN"),
  ]);

  // 合并候选（每国最多15个）
  const allCandidates = {};
  for (const src of [ripeCandidates, apnicCandidates, lacnicCandidates, arinCandidates]) {
    for (const [cc, ips] of Object.entries(src)) {
      if (!allCandidates[cc]) allCandidates[cc] = [];
      for (const ip of ips) {
        if (allCandidates[cc].length < 15 && !allCandidates[cc].includes(ip)) {
          allCandidates[cc].push(ip);
        }
      }
    }
  }

  const totalCandidates = Object.values(allCandidates).reduce((s, a) => s + a.length, 0);
  console.log(`\n候选汇总: ${Object.keys(allCandidates).length} 个国家, ${totalCandidates} 个IP`);

  // Step 2: 首轮验证
  console.log("\n--- Step 2: 首轮 ip-api 验证 ---");
  const verified = await verifyIPs(allCandidates);
  console.log(`首轮通过: ${Object.keys(verified).length} 个国家`);

  // Step 3: 对失败国家用扩展偏移重试
  let missing = ALL_COUNTRIES.filter(cc => !verified[cc]);
  if (missing.length > 0) {
    console.log(`\n--- Step 3: 扩展偏移重试 (${missing.length}个) ---`);
    console.log(`缺失: ${missing.join(", ")}`);

    const missingCandidates = {};
    for (const cc of missing) {
      if (allCandidates[cc]?.length) missingCandidates[cc] = allCandidates[cc];
    }

    // 用不同偏移生成新候选
    const expandedCandidates = expandCandidates(missingCandidates, [25, 75, 150, 200, 250]);
    const extraVerified = await verifyIPs(expandedCandidates, "-expand");
    for (const [cc, ips] of Object.entries(extraVerified)) {
      if (!verified[cc]) verified[cc] = ips;
    }
  }

  // Step 4: 对仍失败的国家使用 KNOWN_RELIABLE
  missing = ALL_COUNTRIES.filter(cc => !verified[cc]);
  if (missing.length > 0) {
    console.log(`\n--- Step 4: 已知可靠IP重试 (${missing.length}个) ---`);
    console.log(`缺失: ${missing.join(", ")}`);

    const knownCandidates = getKnownReliableCandidates(missing);
    if (Object.keys(knownCandidates).length > 0) {
      const knownVerified = await verifyIPs(knownCandidates, "-known");
      for (const [cc, ips] of Object.entries(knownVerified)) {
        if (!verified[cc]) verified[cc] = ips;
      }
    }

    // 仍未覆盖的记录警告
    const stillMissing = ALL_COUNTRIES.filter(cc => !verified[cc]);
    if (stillMissing.length > 0) {
      console.log(`\n⚠️  最终仍未覆盖 (${stillMissing.length}个): ${stillMissing.join(", ")}`);
    }
  }

  // Step 5: 构建输出
  console.log("\n--- Step 5: 构建最终数据 ---");
  const final = buildFinal(verified);

  const covered = Object.keys(final).length;
  const totalExpected = ALL_COUNTRIES.length;
  const finalMissing = ALL_COUNTRIES.filter(cc => !final[cc]);

  console.log(`\n覆盖率: ${covered}/${totalExpected}`);
  if (finalMissing.length > 0) {
    console.log(`未覆盖: ${finalMissing.join(", ")}`);
  }

  // 抽查
  console.log("\n--- 验证抽查 ---");
  for (const cc of ["CN","US","MN","JP","DE","BR","ZA","XK","SC","JM"]) {
    const ips = final[cc];
    console.log(`${cc}: ${ips ? ips.join(", ") : "❌ 无数据"}`);
  }

  // Step 6: 写入
  const payload = {
    ips: final,
    updated_at: new Date().toISOString(),
    source: "ripe-stat+apnic+lacnic+arin verified-by-ip-api",
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
