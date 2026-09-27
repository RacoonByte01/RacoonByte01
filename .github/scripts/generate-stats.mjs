#!/usr/bin/env node
// Self-hosted profile stats. Renders SVG cards from the GitHub API only,
// so the README has zero third-party image dependencies.
// Run locally:  GITHUB_TOKEN=... node .github/scripts/generate-stats.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const API = 'https://api.github.com';
const token = process.env.GITHUB_TOKEN || process.env.STATS_TOKEN || '';
const [owner] = (process.env.GITHUB_REPOSITORY || 'RacoonByte01/RacoonByte01').split('/');
const username = process.env.STATS_USERNAME || owner;
const outDir = process.env.OUT_DIR || 'cards';

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'profile-stats-generator',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

// Colours live in a <style> block so the cards follow the reader's GitHub theme
// instead of staying dark on a light page. Language dots keep their brand colours.
const STYLE = `<style>
.bg{fill:#ffffff}
.bd{stroke:#d0d7de}
.t1{fill:#24292f}
.t2{fill:#57606a}
.track{fill:#eaeef2}
.l0{fill:#ebedf0}
.l1{fill:#9be9a8}
.l2{fill:#40c463}
.l3{fill:#30a14e}
.l4{fill:#216e39}
@media (prefers-color-scheme: dark){
.bg{fill:#0d1117}
.bd{stroke:#30363d}
.t1{fill:#e6edf3}
.t2{fill:#8b949e}
.track{fill:#21262d}
.l0{fill:#161b22}
.l1{fill:#0e4429}
.l2{fill:#006d32}
.l3{fill:#26a641}
.l4{fill:#39d353}
}</style>`;

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_WINDOW = 6;

const LANG_COLORS = {
  c: '#555555',
  'c++': '#f34b7d',
  'c#': '#178600',
  css: '#563d7c',
  dockerfile: '#384d54',
  go: '#00add8',
  html: '#e34c26',
  java: '#b07219',
  javascript: '#f1e05a',
  json: '#cbcb41',
  kotlin: '#a97bff',
  lua: '#000080',
  markdown: '#083fa1',
  php: '#4f5d95',
  python: '#3572a5',
  rust: '#dea584',
  shell: '#89e051',
  sql: '#e38c00',
  typescript: '#3178c6',
  vimscript: '#199f4b',
  yaml: '#cb171e',
};

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const num = (n) => Number(n || 0).toLocaleString('en-US');

const card = (w, h, body) =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" font-family="${FONT}">`,
    STYLE,
    `<rect class="bg" width="${w}" height="${h}" rx="10"/>`,
    `<rect class="bd" x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="none"/>`,
    body,
    '</svg>',
  ].join('');

async function rest(path) {
  const res = await fetch(API + path, { headers: HEADERS });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${res.statusText}`);
  return res.json();
}

async function graphql(query, variables) {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`POST /graphql -> ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL: ${json.errors.map((e) => e.message).join(' | ')}`);
  return json.data;
}

function languagesCard(langs) {
  // 286 x 180 renders at the same scale as the activity card (643 x 180) at the
  // widths the README uses, so both cards come out the same height and still fit
  // side by side in the readme column.
  const w = 286;
  const h = 180;
  const rowH = 26;
  const top = 40;
  const barX = 22;
  const barW = w - barX * 2;

  const total = langs.reduce((acc, l) => acc + l.bytes, 0) || 1;
  const max = langs[0]?.bytes || 1;

  const rows = langs
    .map((l, i) => {
      const y = top + i * rowH;
      const pct = (l.bytes / total) * 100;
      const wBar = Math.max(3, (l.bytes / max) * barW);
      const color = LANG_COLORS[l.name.toLowerCase()] || '#8b949e';
      return [
        `<circle cx="26" cy="${y + 6}" r="5" fill="${color}"/>`,
        `<text class="t1" x="38" y="${y + 11}" font-size="12">${esc(l.name)}</text>`,
        `<text class="t2" x="${w - 22}" y="${y + 11}" font-size="11" text-anchor="end">${pct.toFixed(1)}%</text>`,
        `<rect class="track" x="${barX}" y="${y + 17}" width="${barW}" height="6" rx="3"/>`,
        `<rect x="${barX}" y="${y + 17}" width="${wBar.toFixed(1)}" height="6" rx="3" fill="${color}"/>`,
      ].join('');
    })
    .join('');

  const head = `<text class="t1" x="22" y="26" font-size="13" font-weight="600">Top languages</text>`;
  const empty = `<text class="t2" x="22" y="60" font-size="11">No language data yet</text>`;
  return card(w, h, head + (langs.length ? rows : empty));
}

// Contributions grouped into the last MONTH_WINDOW calendar months, current one
// included (so the last bar is always partial). Everything the card shows is
// summed from the daily counts, never from calendar.totalContributions, which
// does not always match the sum of the days.
function recentActivity(days, count) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const from = Date.UTC(year, month - (count - 1), 1);

  const inWindow = days.filter((d) => Date.parse(`${d.date}T00:00:00Z`) >= from);

  const months = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const at = new Date(Date.UTC(year, month - i, 1));
    months.push({
      label: MONTHS[at.getUTCMonth()],
      year: at.getUTCFullYear(),
      key: `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`,
      total: 0,
      activeDays: 0,
      days: 0,
    });
  }
  const byKey = new Map(months.map((b) => [b.key, b]));
  for (const d of inWindow) {
    const bucket = byKey.get(d.date.slice(0, 7));
    if (!bucket) continue;
    bucket.total += d.count;
    bucket.days += 1;
    if (d.count > 0) bucket.activeDays += 1;
  }

  const total = inWindow.reduce((sum, d) => sum + d.count, 0);
  const activeDays = inWindow.filter((d) => d.count > 0).length;
  return {
    months,
    days: inWindow,
    total,
    activePct: inWindow.length ? Math.round((activeDays / inWindow.length) * 100) : 0,
  };
}

function activityCard(months, { currentStreak, longestStreak, total, activePct }) {
  // Rendered 1:1 in the README, so both cards keep the same height by construction.
  const w = 420;
  const h = 180;
  const pad = 22;
  const base = 127;
  const top = 60;
  const plotW = w - pad * 2;
  const slot = plotW / months.length;
  const barW = 34;
  const max = Math.max(1, ...months.map((m) => m.total));

  const bars = months
    .map((m, i) => {
      const cx = pad + slot * (i + 0.5);
      const height = m.total === 0 ? 2 : Math.max(3, Math.round((m.total / max) * (base - top)));
      const x = (cx - barW / 2).toFixed(1);
      const y = base - height;
      const tip =
        `${m.total} contribution${m.total === 1 ? '' : 's'} in ${m.label} ${m.year} · ` +
        `${m.activeDays} active day${m.activeDays === 1 ? '' : 's'} of ${m.days}`;
      return [
        `<rect class="${m.total === 0 ? 'l0' : 'l3'}" x="${x}" y="${y}" width="${barW}" height="${height}" rx="3">` +
        `<title>${esc(tip)}</title></rect>`,
        `<text class="t1" x="${cx.toFixed(1)}" y="${y - 6}" font-size="9" text-anchor="middle">${m.total}</text>`,
        `<text class="t2" x="${cx.toFixed(1)}" y="${base + 14}" font-size="9" text-anchor="middle">${m.label}</text>`,
      ].join('');
    })
    .join('');

  const axis = `<rect class="l0" x="${pad}" y="${base}" width="${plotW}" height="1"/>`;

  const streak =
    `<text class="t2" x="22" y="${h - 22}" font-size="11">` +
    `Current streak <tspan class="t1" font-weight="600">${num(currentStreak)}d</tspan>` +
    ` &#183; Longest <tspan class="t1" font-weight="600">${num(longestStreak)}d</tspan>` +
    ` &#183; <tspan class="t1" font-weight="600">${num(activePct)}%</tspan> active days` +
    `</text>`;

  const head =
    `<text class="t1" x="22" y="26" font-size="13" font-weight="600">Contribution activity` +
    `<tspan class="t2" font-weight="400"> &#183; last ${MONTH_WINDOW} months</tspan></text>` +
    `<text class="t2" x="${w - pad}" y="26" font-size="11" text-anchor="end">${num(total)} contributions</text>`;

  return card(w, h, head + bars + axis + streak);
}

function streaksFrom(days) {
  let current = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (days[i].count > 0) current += 1;
    else if (i === days.length - 1) continue;
    else break;
  }
  let longest = 0;
  let run = 0;
  for (const d of days) {
    if (d.count > 0) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return { currentStreak: current, longestStreak: longest };
}

async function fetchAllRepos() {
  const repos = [];
  for (let page = 1; ; page += 1) {
    const batch = await rest(`/users/${username}/repos?per_page=100&type=owner&sort=updated&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) return repos;
  }
}

const CONTRIB_QUERY = `
  query ($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              contributionCount
              date
            }
          }
        }
      }
    }
  }
`;

async function main() {
  if (!token) {
    throw new Error('GITHUB_TOKEN is required: the GraphQL contribution calendar is only available to authenticated requests.');
  }

  const [contrib, repos] = await Promise.all([graphql(CONTRIB_QUERY, { login: username }), fetchAllRepos()]);

  const own = repos.filter((r) => !r.fork);
  const stars = own.reduce((acc, r) => acc + r.stargazers_count, 0);

  const totals = new Map();
  for (const repo of own.filter((r) => r.size > 0)) {
    const bytes = await rest(`/repos/${repo.owner.login}/${repo.name}/languages`);
    for (const [name, size] of Object.entries(bytes)) {
      totals.set(name, (totals.get(name) || 0) + size);
    }
  }
  const langs = [...totals.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5);

  const calendar = contrib.user.contributionsCollection.contributionCalendar;
  const days = calendar.weeks
    .flatMap((wk) => wk.contributionDays.map((d) => ({ count: d.contributionCount, date: d.date })))
    .sort((a, b) => a.date.localeCompare(b.date));

  const activity = recentActivity(days, MONTH_WINDOW);

  const cards = {
    'activity.svg': activityCard(activity.months, {
      ...streaksFrom(activity.days),
      total: activity.total,
      activePct: activity.activePct,
    }),
    'languages.svg': languagesCard(langs),
  };

  await mkdir(outDir, { recursive: true });
  for (const [file, svg] of Object.entries(cards)) {
    await writeFile(join(outDir, file), `${svg}\n`, 'utf8');
    console.log(`wrote ${join(outDir, file)} (${svg.length} bytes)`);
  }
  console.log(
    `@${username}: ${own.length} repos, ${stars} stars, ` +
      `${activity.total} contributions in the last ${MONTH_WINDOW} months, ` +
      `top languages: ${langs.map((l) => l.name).join(', ') || 'none'}`
  );
}

main().catch((err) => {
  console.error(`stats generation failed: ${err.message}`);
  process.exit(1);
});
