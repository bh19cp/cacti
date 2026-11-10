import fs from "fs";
import path from "path";
import type { GovernanceConfig } from "../governance-config/governance-config";
import { EXPECTED_POLICY_KEYS } from "../../../../../main/typescript/governance/governance-policy-config";

const CONFIG_DIR = path.resolve(
  __dirname,
  "../../../../../../governance-demo-dao",
);

export const CONFIG_TEMPLATE = path.join(
  CONFIG_DIR,
  "dao.config.template.json",
);
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function writeConfigFromTemplate(
  values: Record<string, string>,
): GovernanceConfig {
  const raw = fs
    .readFileSync(CONFIG_TEMPLATE, "utf8")
    .replace(/\$\{(\w+)\}/g, (m, name) => values[name] ?? m);
  const unresolved = raw.match(/\$\{\w+\}/g);
  if (unresolved)
    throw new Error(
      `${CONFIG_TEMPLATE}: unknown placeholder(s) ${[...new Set(unresolved)].join(", ")}`,
    );

  const config: GovernanceConfig = JSON.parse(raw);
  const unknownKeys = config.protocolParameters
    .map((p) => p.key)
    .filter((k) => !(EXPECTED_POLICY_KEYS as readonly string[]).includes(k));
  if (unknownKeys.length)
    throw new Error(
      `${CONFIG_TEMPLATE}: protocolParameters not in the runtime policy: ${unknownKeys.join(", ")} (allowed: ${EXPECTED_POLICY_KEYS.join(", ")})`,
    );

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
  return config;
}
