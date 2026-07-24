// scripts/update-db.js
const fs = require('fs');
const path = require('path');

// =============================================
// 1. 加载 DB-IP 离线数据库（本地 npm 包）
// =============================================
let geoLookup = null;   // [{startInt, endInt, cc}]

function loadGeoDatabase() {
  try {
    const db = require('@ip-location-db/dbip-country');
    if (!db || !Array.isArray(db) || db.length === 0) {
      throw new Error('db 数据为空');
    }
    console.log(`[DB-IP] 通过 npm 包加载，${db.length} 条记录`);
    const ranges = db.map(row => {
      const start = row.start_ip || row.network;
      const end = row.end_ip || row.end_ip;
      if (!start || !end) return null;
      return {
        startInt: ipToInt(start),
        endInt: ipToInt(end),
        cc: row.country_code?.toUpperCase()
      };
    }).filter(Boolean);
    ranges.sort((a, b) => a.startInt - b.startInt);
    geoLookup = ranges;
    return;
  } catch (e) {
    console.error('[DB-IP] npm 包加载失败，无法继续，请检查依赖安装。', e.message);
    process.exit(1);
  }
}

// =============================================
// 工具函数
// =============================================

function isPublicIP(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const p = ip.split('.').map(Number);
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

function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function intToIP(n) {
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

function addOffset(ip, offset) {
  if (!ip) return null;
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(isNaN)) return null;
  let n = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  n = (n + offset) >>> 0;
  const result = intToIP(n);
  return isPublicIP(result) ? result : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

// DB-IP 查询
function lookupCC(ip) {
  if (!geoLookup) return null;
  const intIP = ipToInt(ip);
  let low = 0, high = geoLookup.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const range = geoLookup[mid];
    if (intIP < range.startInt) high = mid - 1;
    else if (intIP > range.endInt) low = mid + 1;
    else return range.cc;
  }
  return null;
}

// =============================================
// RIR 国家列表
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
  "CD","CG","GA","GQ","CF"
];

const APNIC_COUNTRIES = [
  "CN","JP","KR","AU","SG","HK","TW","MO","MN",
  "MY","TH","VN","ID","PH","MM","KH","LA","BN","TL",
  "IN","BD","LK","NP","BT","MV",
  "NZ","PG","FJ","SB","VU","WS","TO","KI","FM","PW","MH","NR","TV","CK",
  "PK","AF"
];

const LACNIC_COUNTRIES = [
  "BR","AR","CL","CO","PE","VE","EC","BO","PY","UY","GY","SR",
  "MX","GT","BZ","HN","SV","NI","CR","PA",
  "CU","JM","HT","DO","PR","TT","BB","LC","VC","GD","AG","DM","KN","BS"
];

const ARIN_COUNTRIES = ["US","CA"];

const AFRINIC_COUNTRIES = [
  "EG","LY","TN","DZ","MA","MR","SD",
  "NG","GH","CI","SN","CM","ML","BF","NE","TD","GN","SL","LR","TG","BJ","GW","GM","CV",
  "ZA","ZW","ZM","MZ","BW","NA","LS","SZ","AO","MW","MG","MU","SC","KM","ST",
  "ET","KE","TZ","UG","RW","BI","SO","DJ","ER","SS",
  "CD","CG","GA","GQ","CF","LR","SL","BJ","TG"
];

const ALL_COUNTRIES = [...new Set([
  ...RIPE_COUNTRIES, ...APNIC_COUNTRIES, ...LACNIC_COUNTRIES,
  ...ARIN_COUNTRIES, ...AFRINIC_COUNTRIES
])];

const RIR_SOURCES = [
  { name: 'RIPE', fn: fetchRIPEByAPI, countries: RIPE_COUNTRIES },
  { name: 'APNIC', url: 'https://ftp.apnic.net/stats/apnic/delegated-apnic-latest', countries: APNIC_COUNTRIES },
  { name: 'LACNIC', url: 'https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-latest', countries: LACNIC_COUNTRIES },
  { name: 'ARIN', url: 'https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest', countries: ARIN_COUNTRIES },
  { name: 'AFRINIC', url: 'https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-latest', countries: AFRINIC_COUNTRIES },
];

// =============================================
// 3. 从 RIR 获取分配段
// =============================================

function parseDelegated(text, targetCountries) {
  const pool = {};
  const targetSet = new Set(targetCountries);
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const p = trimmed.split('|');
    if (p.length < 7) continue;
    if (p[1] === '*' || p[2] !== 'ipv4') continue;
    const status = p[6]?.split('#')[0].trim();
    if (status === 'summary') continue;
    const cc = p[1]?.toUpperCase();
    const startIP = p[3];
    const count = parseInt(p[4]) || 0;
    if (!cc || cc.length !== 2 || !targetSet.has(cc)) continue;
    if (!isPublicIP(startIP)) continue;
    if (count < 256) continue; // 至少 /24
    if (!pool[cc]) pool[cc] = [];
    if (pool[cc].length < 100) {
      pool[cc].push({ startIP, count });
    }
  }
  return pool;
}

function sampleFromBlocks(blocks, n = 10) {
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

async function fetchDelegated(url, name) {
  console.log(`[${name}] 抓取 delegated ...`);
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(60000),
      headers: { 'User-Agent': 'IP-DB-Collector/5.0' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } catch (e) {
    console.error(`[${name}] 错误: ${e.message}`);
    return '';
  }
}

async function fetchRIPEByAPI() {
  console.log('[RIPE] 通过 stat API 逐国抓取...');
  const candidates = {};
  // 分批次避免同时请求过多
  for (let i = 0; i < RIPE_COUNTRIES.length; i += 8) {
    const batch = RIPE_COUNTRIES.slice(i, i + 8);
    await Promise.all(batch.map(async (cc) => {
      try {
        const resp = await fetch(
          `https://stat.ripe.net/data/country-resource-list/data.json?resource=${cc}&v=4`,
          { signal: AbortSignal.timeout(10000) }
        );
        if (!resp.ok) return;
        const json = await resp.json();
        const prefixes = json?.data?.resources?.ipv4;
        if (!Array.isArray(prefixes) || prefixes.length === 0) return;
        const blocks = [];
        for (const p of prefixes) {
          const prefix = typeof p === 'string' ? p : p?.prefix;
          if (!prefix) continue;
          const [base, bits] = prefix.split('/');
          const count = bits ? Math.pow(2, 32 - parseInt(bits)) : 256;
          if (isPublicIP(base) && count >= 256) blocks.push({ startIP: base, count });
        }
        if (blocks.length > 0) candidates[cc] = blocks;
      } catch (e) { /* 忽略单国错误 */ }
    }));
    await sleep(200);
  }
  console.log(`[RIPE] 完成，${Object.keys(candidates).length} 个国家`);
  return candidates;
}

// =============================================
// 4. 主流程：收集、验证、bypass
// =============================================

async function main() {
  console.log("=== IP 数据库更新开始（DB-IP 离线 npm 版）===");
  const start = Date.now();

  // 0. 加载 DB-IP 数据库
  console.log('\n--- Step 0: 加载离线数据库 ---');
  loadGeoDatabase();

  // 1. 收集所有国家的分配段 (cc -> blocks[])
  console.log('\n--- Step 1: 收集 RIR 分配段 ---');
  const countryBlocks = {};

  for (const source of RIR_SOURCES) {
    if (source.fn) {
      // RIPE API
      const data = await source.fn();
      for (const [cc, blocks] of Object.entries(data)) {
        if (!countryBlocks[cc]) countryBlocks[cc] = [];
        countryBlocks[cc].push(...blocks);
      }
    } else {
      // 解析 delegated 文件
      const text = await fetchDelegated(source.url, source.name);
      if (!text) continue;
      const pool = parseDelegated(text, source.countries);
      for (const [cc, blocks] of Object.entries(pool)) {
        if (!countryBlocks[cc]) countryBlocks[cc] = [];
        countryBlocks[cc].push(...blocks);
      }
    }
  }

  // 去重合并
  for (const cc of Object.keys(countryBlocks)) {
    const seen = new Set();
    countryBlocks[cc] = countryBlocks[cc].filter(b => {
      const key = b.startIP + '/' + b.count;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  console.log(`收集到 ${Object.keys(countryBlocks).length} 个国家的分配段`);

  // 2. 离线验证并自动 bypass
  console.log('\n--- Step 2: DB-IP 离线验证 ---');
  const finalData = {};
  const bypassCCs = [];

  for (const [cc, blocks] of Object.entries(countryBlocks)) {
    // 选取候选 IP
    const candidates = sampleFromBlocks(blocks, 10);
    let passed = [];
    for (const ip of candidates) {
      const actualCC = lookupCC(ip);
      if (actualCC === cc) passed.push(ip);
    }

    if (passed.length >= 2) {
      // 验证可靠，使用通过验证的 IP（最多5个）
      finalData[cc] = passed.slice(0, 5);
    } else {
      // 验证失败 → 自动 bypass
      console.log(`[Bypass] ${cc} 离线验证不可靠 (${passed.length}/${candidates.length})，从 RIR 直接取样`);
      bypassCCs.push(cc);
      // 按 /16 前缀分组，每组取一个代表性的 IP
      const groupMap = new Map();
      for (const b of blocks) {
        const prefix16 = b.startIP.split('.').slice(0, 2).join('.');
        if (!groupMap.has(prefix16)) groupMap.set(prefix16, []);
        groupMap.get(prefix16).push(b);
      }
      const selected = [];
      for (const [, groupBlocks] of groupMap) {
        // 每组内取最大的 block 的中间地址
        const biggest = groupBlocks.reduce((a, b) => a.count > b.count ? a : b);
        const ip = addOffset(biggest.startIP, Math.min(Math.floor(biggest.count / 2), 100));
        if (ip) selected.push(ip);
        if (selected.length >= 4) break;
      }
      if (selected.length > 0) finalData[cc] = selected;
    }
  }

  // 3. 构建最终数据（排序、随机种子）
  console.log('\n--- Step 3: 构建最终数据 ---');
  const today = new Date();
  const ds = today.getUTCFullYear() * 10000 + (today.getUTCMonth() + 1) * 100 + today.getUTCDate();
  for (const [cc, ips] of Object.entries(finalData)) {
    const valid = ips.filter(isPublicIP);
    if (valid.length === 0) {
      delete finalData[cc];
      continue;
    }
    const seed = ds + cc.charCodeAt(0) * 31 + (cc.charCodeAt(1) || 0) * 17;
    const shuffled = seededShuffle(valid, seed);
    finalData[cc] = shuffled.slice(0, Math.min(5, shuffled.length));
  }

  const covered = Object.keys(finalData).length;
  const total = ALL_COUNTRIES.length;
  const missing = ALL_COUNTRIES.filter(cc => !finalData[cc]);
  console.log(`\n覆盖率: ${covered}/${total}`);
  if (missing.length > 0) console.log(`⚠️ 未覆盖: ${missing.join(', ')}`);
  else console.log(`✅ 全部 ${total} 个国家已覆盖！`);

  // 抽查
  console.log('\n--- 抽查 ---');
  for (const cc of ['CN', 'US', 'SC', 'XK', 'JM', 'PR', 'AD', 'TL', 'KI']) {
    console.log(`${cc}: ${finalData[cc] ? finalData[cc].join(', ') : '❌ 无数据'}`);
  }

  // 写入文件
  const payload = {
    ips: finalData,
    updated_at: new Date().toISOString(),
    source: "rir-delegated + db-ip-country-npm",
    country_count: covered,
    coverage_rate: `${covered}/${total}`,
    bypass_countries: bypassCCs,
    missing,
  };

  const outputDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'ip-database.json'), JSON.stringify(payload, null, 2), 'utf8');

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n=== 完成！${covered}/${total} 国，耗时 ${elapsed}s ===`);
}

main().catch(e => {
  console.error('致命错误:', e);
  process.exit(1);
});
