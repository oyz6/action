const fs = require('fs');
const path = require('path');
const maxmind = require('maxmind');

// =============================================
// RIR 国家列表
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

const XK_HARDCODED_FALLBACK = ["46.99.0.1"];

// =============================================
// 工具函数
// =============================================

function isPublicIP(ip) { /* 同前，不变 */ }
function addOffset(ip, offset) { /* 同前 */ }
function chunk(arr, size) { /* 同前 */ }

// =============================================
// 解析 delegated 文件
// =============================================

function parseDelegatedFile(text, targetCountries) { /* 同前 */ }
function sampleFromBlocks(blocks, n) { /* 同前 */ }

// =============================================
// MaxMind 本地验证
// =============================================

let lookupDb = null;
async function initMaxMind() { /* 同前 */ }
async function verifyWithMaxMind(ipList) { /* 同前 */ }

// =============================================
// mra8-api 查询
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
// 自动 Bypass 与 XK 特殊扫描
// =============================================

let RIR_RAW_TEXT = {};

function getAutoBypassIPs(cc) { /* 同前 */ }

function getTerritoryFallbackIPs(cc) { /* 同前 */ }

function getXKCandidatesFromRIPE() { /* 同前 */ }

// =============================================
// 抓取 RIR 候选
// =============================================

async function fetchFromRIR(url, targetCountries, name) { /* 同前 */ }

// =============================================
// 验证流程
// =============================================

async function verifyIPs(candidates, label = "") { /* 同前 */ }

// =============================================
// 构建最终数据
// =============================================

function buildFinal(verified) { /* 同前 */ }

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

  // Step 3: 自动 Bypass 并二次验证（增加候选池后备）
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
      // 如果仍为空且不是 XK，回退到 Step 1 候选池
      if (bypassIPs.length === 0 && cc !== "XK") {
        bypassIPs = allCandidates[cc] || [];
      }

      // 对 XK 特殊处理
      if (cc === "XK") {
        console.log("[BYPASS] XK 启动增强扫描...");
        bypassIPs = getXKCandidatesFromRIPE();
        if (bypassIPs.length === 0) {
          bypassIPs = XK_HARDCODED_FALLBACK.filter(isPublicIP);
        }
      }

      if (bypassIPs.length > 0) {
        const confirmedIPs = [];
        for (const ip of bypassIPs) {
          const apiCountry = await queryMRA8(ip);
          if (apiCountry === null) {
            // 非 XK 时保留未知 IP；XK 时需要明确确认
            if (cc !== "XK") confirmedIPs.push(ip);
          } else if (apiCountry === cc) {
            confirmedIPs.push(ip);
          } else {
            console.log(`[BYPASS] 🔍 ${cc} ${ip} 实际归属 ${apiCountry}，丢弃`);
          }
        }
        bypassIPs = confirmedIPs;
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
