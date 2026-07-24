// scripts/update-db.js
const fs = require('fs');
const path = require('path');

// =============================================
// 策略：
// 1. 从 RIR delegated 文件获取各国 IP 段起始地址
// 2. 用 ip-api.com 批量查询验证实际归属国
// 3. 只保留验证通过的 IP
// =============================================

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

// ARIN 管辖（北美）
const ARIN_COUNTRIES = ["US","CA","AQ"];

const ALL_COUNTRIES = [...new Set([
  ...RIPE_COUNTRIES, ...APNIC_COUNTRIES, ...LACNIC_COUNTRIES, ...ARIN_COUNTRIES
])];

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
// 解析 delegated 文件（正确版本）
// =============================================
function parseDelegatedFile(text, targetCountries) {
  const pool = {}; // cc -> [startIP, ...]
  const targetSet = new Set(targetCountries);

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const p = trimmed.split("|");
    if (p.length < 7) continue;
    if (p[1] === "*") continue;          // version/summary 行
    if (p[2] !== "ipv4") continue;       // 只要 IPv4
    const status = p[6]?.split("#")[0].trim();
    if (status === "summary") continue;  // 汇总行

    const cc = p[1]?.toUpperCase();
    const startIP = p[3];
    const count = parseInt(p[4]) || 0;

    if (!cc || cc.length !== 2) continue;
    if (!targetSet.has(cc)) continue;
    if (!isPublicIP(startIP)) continue;
    if (count < 256) continue;           // 太小的段跳过（/24 以下）

    if (!pool[cc]) pool[cc] = [];
    if (pool[cc].length < 50) {          // 每国最多50个候选段
      pool[cc].push({ startIP, count });
    }
  }
  return pool;
}

// 从段中取样 IP（取段中间附近的地址，避免网络地址）
function sampleFromBlocks(blocks, n) {
  const ips = [];
  const step = Math.max(1, Math.floor(blocks.length / n));
  for (let i = 0; i < blocks.length && ips.length < n; i += step) {
    const { startIP, count } = blocks[i];
    // 取段偏移 count/2 处，更可能是真实主机
    const offset = Math.min(Math.floor(count / 2), 100);
    const ip = addOffset(startIP, offset);
    if (ip) ips.push(ip);
  }
  return ips;
}

// =============================================
// ip-api.com 批量验证（每次最多100个IP）
// 免费版限制：45次/分钟
// =============================================
async function verifyWithIPAPI(ipList) {
  // ip-api.com 批量接口
  const url = "http://ip-api.com/batch?fields=query,countryCode,status";
  const body = ipList.map(ip => ({ query: ip, fields: "query,countryCode,status" }));

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "GH-IPCollector/4.0",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      console.log(`[ip-api] HTTP ${resp.status}`);
      return {};
    }

    const data = await resp.json();
    const result = {}; // ip -> countryCode

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

// =============================================
// 对候选 IP 做批量验证，返回按国家分组的验证通过IP
// =============================================
async function verifyIPs(candidates) {
  // candidates: { cc: [ip, ip, ...], ... }
  // 打平成列表
  const allIPs = [];
  const ipToCC = {}; // 期望的 cc

  for (const [cc, ips] of Object.entries(candidates)) {
    for (const ip of ips) {
      allIPs.push(ip);
      ipToCC[ip] = cc;
    }
  }

  console.log(`[Verify] 共 ${allIPs.length} 个IP待验证...`);

  const verified = {}; // cc -> [verified ip, ...]
  const batches = chunk(allIPs, 100); // ip-api 每批最多100个

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`[Verify] 批次 ${i + 1}/${batches.length} (${batch.length}个IP)...`);

    const result = await verifyWithIPAPI(batch);

    for (const [ip, actualCC] of Object.entries(result)) {
      const expectedCC = ipToCC[ip];
      if (actualCC === expectedCC) {
        if (!verified[actualCC]) verified[actualCC] = [];
        if (verified[actualCC].length < 10) {
          verified[actualCC].push(ip);
        }
      } else {
        // 归属不匹配，记录日志但不丢弃——存到实际国家
        // （比如 AQ 的IP实际是AU，就归到AU）
        // 这里选择丢弃，保证数据纯净
        console.log(`[Verify] ❌ ${ip}: 期望${expectedCC} 实际${actualCC}`);
      }
    }

    // 避免触发速率限制（45次/分钟 → 每批间隔1.5s）
    if (i < batches.length - 1) {
      await sleep(1500);
    }
  }

  return verified;
}

// =============================================
// 从各 RIR 抓取候选 IP
// =============================================

async function fetchFromRIR(url, targetCountries, name) {
  console.log(`[${name}] 抓取 ${url} ...`);
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(60000),
      headers: { "User-Agent": "GH-IPCollector/4.0" },
    });
    if (!resp.ok) {
      console.log(`[${name}] HTTP ${resp.status}`);
      return {};
    }
    const text = await resp.text();
    console.log(`[${name}] 文件大小: ${(text.length / 1024).toFixed(0)} KB`);

    const pool = parseDelegatedFile(text, targetCountries);
    console.log(`[${name}] 解析到 ${Object.keys(pool).length} 个国家的IP段`);

    // 每国取5个候选IP
    const candidates = {};
    for (const [cc, blocks] of Object.entries(pool)) {
      const ips = sampleFromBlocks(blocks, 5);
      if (ips.length > 0) candidates[cc] = ips;
    }
    return candidates;
  } catch (e) {
    console.error(`[${name}] 错误:`, e.message);
    return {};
  }
}

async function fetchRIPEByAPI() {
  // RIPE 用 stat API（已有前缀，不用 delegated）
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
            headers: { "Accept": "application/json", "User-Agent": "GH-IPCollector/4.0" },
          }
        );
        if (!resp.ok) return;
        const json = await resp.json();
        const prefixes = json?.data?.resources?.ipv4;
        if (!Array.isArray(prefixes) || prefixes.length === 0) return;

        // 均匀取5个前缀，取前缀中间地址
        const step = Math.max(1, Math.floor(prefixes.length / 5));
        const ips = [];
        for (let i = 0; i < prefixes.length && ips.length < 5; i += step) {
          const prefix = typeof prefixes[i] === 'string' ? prefixes[i] : prefixes[i]?.prefix;
          if (!prefix) continue;
          const [base, bits] = prefix.split("/");
          const size = bits ? Math.pow(2, 32 - parseInt(bits)) : 256;
          const offset = Math.min(Math.floor(size / 2), 100);
          const ip = addOffset(base, offset);
          if (ip) ips.push(ip);
        }
        if (ips.length > 0) {
          candidates[cc] = ips;
        }
      } catch (e) {
        // 单国失败忽略
      }
    }));
    await sleep(200); // 避免过快
  }
  console.log(`[RIPE] 候选: ${Object.keys(candidates).length} 个国家`);
  return candidates;
}

// ARIN（北美）用 delegated 文件
async function fetchARIN() {
  return fetchFromRIR(
    "https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest",
    ARIN_COUNTRIES,
    "ARIN"
  );
}

// =============================================
// AQ 特殊处理：南极洲没有民用IP，特殊标记
// =============================================
function getAQFallback() {
  // 南极洲科考站实际使用的已知IP段（ARIN/其他分配）
  // British Antarctic Survey: 194.66.252.x
  // US Antarctic Program 通过卫星，IP实际注册在美国
  // 直接标注为无可用IP，返回空
  console.log('[AQ] 南极洲无民用IP，跳过');
  return {};
}

// =============================================
// 最终数据整合
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
    // 每国保留2~4个验证通过的IP
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

  // Step 1: 从各 RIR 获取候选IP
  console.log("\n--- Step 1: 抓取各 RIR 候选IP ---");
  const [ripeCandidates, apnicCandidates, lacnicCandidates, arinCandidates] = await Promise.all([
    fetchRIPEByAPI(),
    fetchFromRIR("https://ftp.apnic.net/stats/apnic/delegated-apnic-latest", APNIC_COUNTRIES, "APNIC"),
    fetchFromRIR("https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-latest", LACNIC_COUNTRIES, "LACNIC"),
    fetchARIN(),
  ]);

  // 合并所有候选（每国最多10个候选）
  const allCandidates = {};
  for (const src of [ripeCandidates, apnicCandidates, lacnicCandidates, arinCandidates]) {
    for (const [cc, ips] of Object.entries(src)) {
      if (!allCandidates[cc]) allCandidates[cc] = [];
      for (const ip of ips) {
        if (allCandidates[cc].length < 10 && !allCandidates[cc].includes(ip)) {
          allCandidates[cc].push(ip);
        }
      }
    }
  }

  // AQ 特殊处理：直接移除，不输出
  delete allCandidates["AQ"];

  const totalCandidates = Object.values(allCandidates).reduce((s, a) => s + a.length, 0);
  console.log(`\n候选汇总: ${Object.keys(allCandidates).length} 个国家, ${totalCandidates} 个IP`);

  // Step 2: ip-api 验证
  console.log("\n--- Step 2: ip-api.com 验证IP归属 ---");
  const verified = await verifyIPs(allCandidates);

  // Step 3: 检查覆盖率，对未覆盖国家补充候选再验证
  const missing = ALL_COUNTRIES.filter(cc => cc !== "AQ" && !verified[cc]);
  if (missing.length > 0) {
    console.log(`\n--- Step 3: 补充验证 ${missing.length} 个缺失国家 ---`);
    console.log(`缺失: ${missing.join(", ")}`);

    // 对缺失国家扩大候选（从候选池取更多IP）
    const extraCandidates = {};
    for (const cc of missing) {
      if (allCandidates[cc]?.length) {
        // 已有候选但验证失败，扩充到10个再试
        extraCandidates[cc] = allCandidates[cc];
      }
    }

    if (Object.keys(extraCandidates).length > 0) {
      const extraVerified = await verifyIPs(extraCandidates);
      for (const [cc, ips] of Object.entries(extraVerified)) {
        if (!verified[cc]) verified[cc] = ips;
      }
    }
  }

  // Step 4: 构建最终数据
  console.log("\n--- Step 4: 构建最终数据 ---");
  const final = buildFinal(verified);

  // Step 5: 统计报告
  const covered = Object.keys(final).length;
  const totalExpected = ALL_COUNTRIES.filter(cc => cc !== "AQ").length;
  const stillMissing = ALL_COUNTRIES.filter(cc => cc !== "AQ" && !final[cc]);

  console.log(`\n覆盖: ${covered}/${totalExpected} 个国家`);
  if (stillMissing.length > 0) {
    console.log(`未覆盖: ${stillMissing.join(", ")}`);
  }

  // 验证抽查
  console.log("\n--- 验证抽查 ---");
  for (const cc of ["CN","US","MN","JP","DE","BR","ZA","AQ"]) {
    const ips = final[cc];
    console.log(`${cc}: ${ips ? ips.join(", ") : "❌ 无数据"}`);
  }

  // Step 6: 写入文件
  const payload = {
    ips: final,
    updated_at: new Date().toISOString(),
    source: "ripe-stat+apnic+lacnic+arin verified-by-ip-api",
    country_count: covered,
    coverage_rate: `${covered}/${totalExpected}`,
  };

  const outputDir = path.join(process.cwd(), "data");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "ip-database.json");
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n=== 完成！耗时 ${elapsed}s，写入 ${outputPath} ===`);
}

main().catch(e => {
  console.error("致命错误:", e);
  process.exit(1);
});
