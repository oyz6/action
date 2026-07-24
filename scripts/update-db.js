// scripts/update-db.js
const fs = require('fs');
const path = require('path');
const { createReadStream } = require('fs');
const readline = require('readline');

// =============================================
// 配置
// =============================================

// DB-IP 免费 lite 数据库下载地址（国家级别，CSV 格式）
const DBIP_URL = 'https://download.db-ip.com/free/dbip-country-lite-2024-07.csv.gz';
// 也可以用更通用的不变链接（需要定期更新年份），这里固定一个可用版本
// 实际使用时建议用 https://cdn.jsdelivr.net/npm/@ip-location-db/dbip-country/dbip-country.csv
const DBIP_FALLBACK = 'https://cdn.jsdelivr.net/npm/@ip-location-db/dbip-country/dbip-country.csv';

// RIR 国家列表（含 AFRINIC）
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
  // 注意 RIPE 已包含部分非洲国家，这里是纯 AFRINIC 区域（避免重复）
  // 实际运行时我们会合并去重，但为了清晰单独列出剩下的
  "EG","LY","TN","DZ","MA","MR","SD", // 这些在 RIPE 中已有，但 AF 区也包括
  "NG","GH","CI","SN","CM","ML","BF","NE","TD","GN","SL","LR","TG","BJ","GW","GM","CV",
  "ZA","ZW","ZM","MZ","BW","NA","LS","SZ","AO","MW","MG","MU","SC","KM","ST",
  "ET","KE","TZ","UG","RW","BI","SO","DJ","ER","SS",
  "CD","CG","GA","GQ","CF","LR","SL","BJ","TG" // 去重
];

// 最终合并所有要抓取的国家
const ALL_COUNTRIES = [...new Set([
  ...RIPE_COUNTRIES, ...APNIC_COUNTRIES, ...LACNIC_COUNTRIES,
  ...ARIN_COUNTRIES, ...AFRINIC_COUNTRIES
])];

// RIR 抓取配置
const RIR_SOURCES = [
  { name: 'RIPE', fn: fetchRIPEByAPI, countries: RIPE_COUNTRIES },
  { name: 'APNIC', url: 'https://ftp.apnic.net/stats/apnic/delegated-apnic-latest', countries: APNIC_COUNTRIES },
  { name: 'LACNIC', url: 'https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-latest', countries: LACNIC_COUNTRIES },
  { name: 'ARIN', url: 'https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest', countries: ARIN_COUNTRIES },
  { name: 'AFRINIC', url: 'https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-latest', countries: AFRINIC_COUNTRIES },
];

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

// =============================================
// 1. 下载并解析 DB-IP 离线国家库
// =============================================

let geoLookup = null; // { ipRanges: [{start, end, cc}], sorted }

async function downloadDBIP() {
  console.log('[DB-IP] 下载离线国家数据库...');
  const urls = [DBIP_URL, DBIP_FALLBACK];
  let csvText = null;
  for (const url of urls) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) continue;
      csvText = await resp.text();
      console.log(`[DB-IP] 成功从 ${url} 下载 (${(csvText.length/1024/1024).toFixed(1)} MB)`);
      break;
    } catch (e) {
      console.log(`[DB-IP] 下载失败: ${url} - ${e.message}`);
    }
  }
  if (!csvText) throw new Error('无法下载 DB-IP 数据库');

  // 解析 CSV 格式: start_ip,end_ip,country_code
  const ranges = [];
  const lines = csvText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes(',')) continue;
    const parts = trimmed.split(',');
    if (parts.length < 3) continue;
    const start = parts[0].replace(/"/g, '').trim();
    const end = parts[1].replace(/"/g, '').trim();
    const cc = parts[2].replace(/"/g, '').trim().toUpperCase();
    if (!isPublicIP(start) || !isPublicIP(end) || cc.length !== 2) continue;
    ranges.push({ startInt: ipToInt(start), endInt: ipToInt(end), cc });
  }
  // 排序以便二分查找
  ranges.sort((a, b) => a.startInt - b.startInt);
  console.log(`[DB-IP] 解析完成，共 ${ranges.length} 条记录`);
  geoLookup = ranges;
}

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
// 2. 解析 RIR delegated 文件
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
    // 仅接受已分配/已指派的大段（至少 /24）
    if (count < 256) continue;
    if (!pool[cc]) pool[cc] = [];
    if (pool[cc].length < 100) {  // 每国最多存100个段
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

// =============================================
// 3. 抓取 RIR 候选 IP
// =============================================

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
  const batches = [];
  for (let i = 0; i < RIPE_COUNTRIES.length; i += 8) {
    batches.push(RIPE_COUNTRIES.slice(i, i + 8));
  }
  for (const batch of batches) {
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
        const ips = [];
        const step = Math.max(1, Math.floor(prefixes.length / 8));
        for (let i = 0; i < prefixes.length && ips.length < 8; i += step) {
          const prefix = typeof prefixes[i] === 'string' ? prefixes[i] : prefixes[i]?.prefix;
          if (!prefix) continue;
          const [base, bits] = prefix.split('/');
          const size = bits ? Math.pow(2, 32 - parseInt(bits)) : 256;
          const offset = Math.min(Math.floor(size / 2), 100);
          const ip = addOffset(base, offset);
          if (ip) ips.push(ip);
        }
        if (ips.length > 0) candidates[cc] = ips;
      } catch (e) { /* 忽略单个国家错误 */ }
    }));
    await sleep(200);
  }
  console.log(`[RIPE] 完成，${Object.keys(candidates).length} 个国家`);
  return candidates;
}

async function gatherCandidates() {
  const allCandidates = {};
  const promises = RIR_SOURCES.map(async (source) => {
    if (source.fn) {
      const data = await source.fn();
      for (const [cc, ips] of Object.entries(data)) {
        if (!allCandidates[cc]) allCandidates[cc] = [];
        for (const ip of ips) {
          if (allCandidates[cc].length < 15 && !allCandidates[cc].includes(ip)) {
            allCandidates[cc].push(ip);
          }
        }
      }
    } else if (source.url) {
      const text = await fetchDelegated(source.url, source.name);
      if (text) {
        const pool = parseDelegated(text, source.countries);
        for (const [cc, blocks] of Object.entries(pool)) {
          const ips = sampleFromBlocks(blocks, 8);
          if (!allCandidates[cc]) allCandidates[cc] = [];
          for (const ip of ips) {
            if (allCandidates[cc].length < 15 && !allCandidates[cc].includes(ip)) {
              allCandidates[cc].push(ip);
            }
          }
        }
      }
    }
  });
  await Promise.all(promises);
  return allCandidates;
}

// =============================================
// 4. 离线验证 + 自动 bypass
// =============================================

async function verifyAndBypass(candidates) {
  const verified = {};   // cc -> [ips]
  const bypass = {};     // cc -> [ips]

  console.log(`\n[验证] 使用 DB-IP 离线库验证 ${Object.keys(candidates).length} 个国家...`);

  for (const [cc, ips] of Object.entries(candidates)) {
    const valid = [];
    const invalid = [];
    for (const ip of ips) {
      const actualCC = lookupCC(ip);
      if (actualCC === cc) {
        valid.push(ip);
      } else {
        invalid.push({ ip, actual: actualCC });
      }
    }
    if (valid.length >= 2) {
      // 有足够准确验证的 IP
      verified[cc] = valid.slice(0, 5);
    } else {
      // 全部失败或不足：进入 bypass 模式
      console.log(`[Bypass] ${cc} 验证失败 (通过${valid.length}/${ips.length})，将从 RIR 直接提取`);
      // 从该国的 RIR 段中重新采样更多 IP，取不同 /16 段
      const blocks = [];
      // 再快速抓一次该国的 delegated（这里直接用已缓存的文本？）
      // 为简化，直接从 candidates 的原始 pool 里获取（但 candidates 只存了 IP）
      // 因此我们需额外保存每个国家的 blocks。重构 gatherCandidates 使其同时返回 blocks。
      // 这里暂时使用一个回退：针对每个国家重新 fetch RIPE API 或 delegated 文件取出 blocks。
      // 但为了不重复网络请求，我们可以在 gatherCandidates 时顺便保存每个国家的 blocks 列表。
      // 我们修改 gatherCandidates 使其返回 {candidates, blocksPool}
    }
  }

  // 由于上面的问题，我们需要修改结构：让 gatherCandidates 同时返回 blocks 信息。
  // 实际实现时，我们可以在 gatherCandidates 里为每个国家保存所有 block 信息到一个 map。
  // 这里给出完整优化后的方案：
}

// 注意：上面的伪代码有缺陷，我们需要在收集阶段保存每个国家的原始分配段，以便 bypass 时采样。
// 因此重构整个流程如下：

// =============================================
// 完整流程（重构）
// =============================================

async function main() {
  console.log("=== IP 数据库更新开始（DB-IP 离线版）===");
  const start = Date.now();

  // 1. 下载离线数据库
  await downloadDBIP();

  // 2. 收集 RIR 分配段（同时保存 blocks 用于 bypass）
  console.log("\n--- Step 1: 收集 RIR 分配段 ---");
  const countryBlocks = {};  // cc -> [{startIP, count}, ...]

  // 处理所有 RIR 源
  for (const source of RIR_SOURCES) {
    if (source.fn) {
      // RIPE API
      console.log('[RIPE] 获取分配数据...');
      for (const cc of source.countries) {
        try {
          const resp = await fetch(
            `https://stat.ripe.net/data/country-resource-list/data.json?resource=${cc}&v=4`,
            { signal: AbortSignal.timeout(10000) }
          );
          if (!resp.ok) continue;
          const json = await resp.json();
          const prefixes = json?.data?.resources?.ipv4;
          if (!Array.isArray(prefixes)) continue;
          const blocks = prefixes.map(p => {
            const prefix = typeof p === 'string' ? p : p?.prefix;
            if (!prefix) return null;
            const [base, bits] = prefix.split('/');
            const count = bits ? Math.pow(2, 32 - parseInt(bits)) : 256;
            return { startIP: base, count };
          }).filter(b => b && isPublicIP(b.startIP) && b.count >= 256);
          if (blocks.length > 0) countryBlocks[cc] = blocks;
        } catch (e) {}
        await sleep(50); // 避免请求过快
      }
    } else {
      // 解析 delegated 文件
      console.log(`[${source.name}] 抓取...`);
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

  // 3. 采样候选 IP 并用 DB-IP 验证
  console.log("\n--- Step 2: 离线验证 ---");
  const finalData = {};
  const bypassCCs = [];

  for (const [cc, blocks] of Object.entries(countryBlocks)) {
    // 从每个国家的 blocks 中选取 10 个候选 IP
    const candidates = sampleFromBlocks(blocks, 10);
    let passed = [];
    for (const ip of candidates) {
      const actualCC = lookupCC(ip);
      if (actualCC === cc) passed.push(ip);
    }

    if (passed.length >= 2) {
      // 验证可靠，保留通过验证的 IP（最多5个）
      finalData[cc] = passed.slice(0, 5);
    } else {
      // 验证失败，自动 bypass：直接从不同 /16 段中各取一个中间 IP
      console.log(`[Bypass] ${cc} 离线验证不可靠 (通过${passed.length}/${candidates.length})，使用 RIR 段直接取样`);
      bypassCCs.push(cc);
      // 按 startIP 的前两段分组，每组取一个 IP
      const groupMap = new Map();
      for (const b of blocks) {
        const prefix16 = b.startIP.split('.').slice(0, 2).join('.');
        if (!groupMap.has(prefix16)) groupMap.set(prefix16, []);
        groupMap.get(prefix16).push(b);
      }
      const selected = [];
      for (const [, groupBlocks] of groupMap) {
        // 取该组中最大的一个块，其中间地址
        const biggest = groupBlocks.reduce((a, b) => a.count > b.count ? a : b);
        const ip = addOffset(biggest.startIP, Math.min(Math.floor(biggest.count / 2), 100));
        if (ip) selected.push(ip);
        if (selected.length >= 4) break;
      }
      if (selected.length > 0) finalData[cc] = selected;
    }
  }

  // 4. 终处理：排序、随机化（保持确定性）
  console.log("\n--- Step 3: 构建最终数据 ---");
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
  console.log("\n--- 抽查 ---");
  for (const cc of ['CN', 'US', 'SC', 'XK', 'JM', 'PR', 'AD', 'TL', 'KI']) {
    console.log(`${cc}: ${finalData[cc] ? finalData[cc].join(', ') : '❌ 无数据'}`);
  }

  // 写入文件
  const payload = {
    ips: finalData,
    updated_at: new Date().toISOString(),
    source: "rir-delegated + db-ip-country-lite",
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
