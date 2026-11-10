const w = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
export const c = { bold: w(1), dim: w(2), red: w(31), green: w(32), yellow: w(33), cyan: w(36) };

export const banner = (s: string) => console.log(`\n${c.bold(c.cyan(`━━ ${s} ━━`))}`);
export const info = (s: string) => console.log(`  ${s}`);
export const ok = (s: string) => console.log(`  ${c.green("✔")} ${s}`);
export const bad = (s: string) => console.log(`  ${c.red("✘")} ${s}`);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));