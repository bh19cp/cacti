import * as readline from "readline/promises";
import {
  encodeSetParameter,
  encodeSetGatewayStatus,
} from "../utils/governance-encode-utils";
import { GatewayStatus } from "../utils/governance-test-utils";
import {
  bootEnv,
  deployEnv,
  DemoEnv,
  DeployedEnv,
  GwName,
  GW_LEDGER,
  GW_NAMES,
} from "./env";
import { runLifecycle, PhaseResult } from "./lifecycle";
import { runTransfer } from "./transfer";
import { directWrite } from "./direct";
import {
  letterOf,
  readRuntimeParam,
  readSessionLockExpiration,
  readGatewayStatusCache,
  waitForRuntimeParam,
  waitForGatewayStatus,
} from "./adapters";
import fs from "fs";
import { banner, info, ok, bad, c } from "./ui";
import { CONFIG_FILE, CONFIG_TEMPLATE } from "./config";
import { IEVMOracleEntry } from "../../../../../main/typescript/cross-chain-mechanisms/oracle/implementations/oracle-evm";

const KEY = "satp.session.lockExpirationTime";
const statusLabel = (s: number | bigint | undefined) =>
  s === undefined
    ? c.dim("not cached")
    : GatewayStatus[Number(s)] ?? `status ${s}`;

const gw = (s?: string): GwName => {
  const n = s?.toUpperCase();
  if (!GW_NAMES.includes(n as GwName))
    throw new Error("gateway must be A, B or C");
  return n as GwName;
};
/** One letter if given, otherwise all of them. */
const letters = (s?: string): readonly GwName[] => (s ? [gw(s)] : GW_NAMES);

const deployed = (env: DemoEnv): DeployedEnv => {
  if (!env.dao) throw new Error("DAO not deployed yet, run 'deploy-dao' first");
  return env as DeployedEnv;
};
const withGateways = (env: DemoEnv) => {
  const e = deployed(env);
  if (!e.gms || !e.gateways)
    throw new Error("gateways are not running (--lite mode)");
  return e as DeployedEnv & Required<Pick<DemoEnv, "gms" | "gateways">>;
};

const logPhase = (r: PhaseResult) => {
  info(
    `${c.dim("•")} ${r.phase.padEnd(9)} ${String(r.timeMs).padStart(5)} ms  ${(r.gasUsed.toLocaleString() + " gas").padEnd(12)} block ${String(r.blockNumber).padEnd(5)} tx ${r.txHash}`,
  );
  if (r.proposalId) info(c.dim(`  proposalId ${r.proposalId}`));
};

async function readOracle(
  env: DeployedEnv,
  registry: "policy" | "gateway",
  methodName: string,
  params: unknown[] = [],
) {
  const isPolicy = registry === "policy";
  const r = await env.oracle.readEntry({
    contractName: isPolicy ? "PolicyRegistry" : "GatewayRegistry",
    contractAddress: isPolicy
      ? env.dao.addresses.policyRegistry
      : env.dao.addresses.gatewayRegistry,
    contractAbi: isPolicy ? env.abis.policyRegistry : env.abis.gatewayRegistry,
    contractBytecode: "",
    methodName,
    params,
  } as IEVMOracleEntry);
  return r.output as any;
}

const printParam = (p: any) =>
  info(
    `${String(p.key).padEnd(34)} ${c.bold(String(p.value))}  ${c.dim(`updatedAt ${p.updatedAt}`)}`,
  );

type Cmd = (env: DemoEnv, args: string[]) => Promise<void>;
const commands: Record<string, Cmd> = {
  async "deploy-dao"(env) {
    banner(
      "Deploy DAO from governance-demo-dao/config.json to the Geth ledger",
    );
    const t0 = Date.now();
    const { dao } = await deployEnv(env);
    for (const { label, receipt } of dao.receipts)
      info(
        `${c.dim("•")} ${label.padEnd(40)} block ${String(receipt.blockNumber).padEnd(5)} tx ${receipt.transactionHash}`,
      );
    ok(
      `deployed in ${Date.now() - t0} ms${env.lite ? " (lite: no gateways started)" : ""}`,
    );
    await commands["deploy-report"](env, []);
  },

  async "deploy-report"(env) {
    const { dao } = deployed(env);
    banner("Deploy report");
    for (const [name, addr] of Object.entries(dao.addresses))
      if (addr) info(`${name.padEnd(16)} ${addr}`);
    info("");
    for (const n of GW_NAMES)
      info(
        `Gateway ${c.bold(n)} ${c.dim(`(${GW_LEDGER[n].padEnd(10)})`)} ${env.gwKeys[n]}`,
      );
  },

  async "propose-gateway-status-active"(env, [name]) {
    await setStatus(deployed(env), gw(name), GatewayStatus.Active);
  },
  async "propose-gateway-status-suspend"(env, [name]) {
    await setStatus(deployed(env), gw(name), GatewayStatus.Suspended);
  },

  async "propose-policy-parameter"(env, [key = KEY, value = "120"]) {
    const e = deployed(env);
    banner(`Proposal: set ${key} = ${value}`);
    await runLifecycle(
      e,
      [
        {
          target: e.dao.addresses.policyRegistry,
          calldata: encodeSetParameter(e.web3, key, BigInt(value)),
        },
      ],
      `Demo: set ${key} to ${value} [${Date.now()}]`,
      logPhase,
    );
    if (!e.gms) return ok("proposal executed");
    const ms = await waitForRuntimeParam(e, key, value);
    ok(
      `all gateways now run with ${key} = ${c.bold(value)} (${ms} ms after execution, no restart)`,
    );
  },

  async "check-governance-manager-cache"(env, [name]) {
    const e = withGateways(env);
    for (const n of letters(name)) {
      banner(`GovernanceManager cache of Gateway ${n}`);
      const cache = readGatewayStatusCache(e, n);
      if (cache.size === 0) info(c.dim("(empty)"));
      for (const [key, status] of cache)
        info(
          `${c.bold(letterOf(e, key) ?? "?")}  ${statusLabel(status).padEnd(10)} ${c.dim(key)}`,
        );
    }
  },

  async "check-policy-runtime"(env, [name]) {
    const e = withGateways(env);
    for (const n of letters(name)) {
      banner(`Runtime policy of Gateway ${n}`);
      for (const [field, v] of Object.entries(e.gms[n].getRuntimePolicy()))
        info(`${field.padEnd(20)} ${c.bold(String(v))}`);
    }
  },

  async "read-oracle"(env, [what, key]) {
    const e = deployed(env);
    if (!what || what === "gateways") {
      banner("Oracle: GatewayRegistry.getAllGateways()");
      for (const g of await readOracle(e, "gateway", "getAllGateways"))
        info(
          `${c.bold(letterOf(e, g.publicKey) ?? "?")}  ${String(g.name).padEnd(10)} ${statusLabel(g.status).padEnd(10)} ${c.dim(`org ${g.orgWallet}`)}`,
        );
    }
    if (what === "param") {
      const k = key ?? KEY;
      banner(`Oracle: PolicyRegistry.getParameter("${k}")`);
      printParam(await readOracle(e, "policy", "getParameter", [k]));
    } else if (!what || what === "params") {
      banner("Oracle: PolicyRegistry.getAllParameters()");
      for (const p of await readOracle(e, "policy", "getAllParameters"))
        printParam(p);
    } else if (what !== "gateways") {
      throw new Error("usage: read-oracle [gateways | params | param <key>]");
    }
  },

  async transfer(env, [from, to]) {
    const e = withGateways(env);
    const [a, b] = [gw(from), gw(to)];
    if (a === b) throw new Error("source and destination gateways must differ");
    banner(
      `SATP transfer: Gateway ${a} (${GW_LEDGER[a]}) to Gateway ${b} (${GW_LEDGER[b]})`,
    );
    const policy = readRuntimeParam(e, a, KEY);
    const r = await runTransfer(e, a, b);
    r.ok
      ? ok(`transfer DONE in ${r.ms} ms`)
      : bad(`transfer rejected / failed: ${r.reason}`);
    if (!r.sessionId) return;
    info(`runtime policy of Gateway ${a}: ${KEY} = ${c.bold(String(policy))}`);
    for (const n of [a, b]) {
      const s = readSessionLockExpiration(e, n, r.sessionId);
      info(
        s
          ? `session ${r.sessionId.slice(0, 8)}… on Gateway ${n} (${s.side}): lockExpirationTime = ${c.bold(s.value)}`
          : c.dim(
              `session ${r.sessionId.slice(0, 8)}… not present on Gateway ${n}`,
            ),
      );
    }
  },

  async "direct-write"(env, [what, ...args]) {
    const e = deployed(env);
    const caller = e.orgs[0];
    let target: string, abi: any[], method: string, params: unknown[];
    if (what === "set-param") {
      const [key = KEY, value = "120"] = args;
      [target, abi, method, params] = [
        e.dao.addresses.policyRegistry,
        e.abis.policyRegistry,
        "setParameter",
        [key, BigInt(value)],
      ];
    } else if (what === "suspend-gateway" || what === "activate-gateway") {
      const n = gw(args[0]);
      const status =
        what === "suspend-gateway"
          ? GatewayStatus.Suspended
          : GatewayStatus.Active;
      [target, abi, method, params] = [
        e.dao.addresses.gatewayRegistry,
        e.abis.gatewayRegistry,
        "setGatewayStatus",
        [
          "0x" + e.gwKeys[n].replace(/^0x/, ""),
          status,
          "direct write, no proposal",
        ],
      ];
    } else
      throw new Error(
        "usage: direct-write set-param [key] [value] | suspend-gateway <L> | activate-gateway <L>",
      );

    banner(
      `Direct write, bypassing governance: ${method}(${params.join(", ")})`,
    );
    info(
      `caller   Organization A ${caller.ethAccount} (DAO member, holds voting tokens)`,
    );
    info(`target   ${target}`);
    const r = await directWrite(e.web3, caller, target, abi, method, params);
    bad(`rejected: ${c.bold(r.revert)}`);
    info(
      `tx ${r.txHash} mined in block ${r.blockNumber} with status ${r.status} (${r.status === 0n ? "reverted" : "SUCCESS?!"})`,
    );
    info(
      c.dim(
        "only the registry owner (the governor / timelock) can write; run read-oracle to see nothing changed",
      ),
    );
  },
};

const USAGE = [
  "start-ledgers [lite]                   boot Ethereum + Besu ledgers ('lite': Ethereum only)",
  "show-config [template]                 the DAO config.json deploy-dao uses (or its template)",
  "deploy-dao                             deploy the DAO from config.json (registers orgs + gateways), start gateways",
  "deploy-report                          contract addresses and gateway keys",
  "propose-gateway-status-active <A|B|C>  governance proposal: set gateway Active",
  "propose-gateway-status-suspend <A|B|C> governance proposal: set gateway Suspended",
  `propose-policy-parameter [name] [value] governance proposal: set a policy parameter (default ${KEY} 120)`,
  "check-governance-manager-cache [A|B|C] gateway status cache of one / all GovernanceManagers",
  "check-policy-runtime [A|B|C]           runtime policy of one / all gateways",
  "read-oracle [gateways|params|param <key>]  read the registries through the oracle",
  "direct-write set-param [key] [value] | suspend-gateway <L> | activate-gateway <L>  write a registry directly, without a proposal (rejected)",
  "transfer <FROM> <TO>                   SATP transfer between gateways (A=Besu, B=Ethereum, C=Ethereum-2)",
  "stop                                   stop GovernanceManagers, gateways and ledger containers (CLI stays open)",
  "exit                                   stop everything and quit",
];

async function setStatus(env: DeployedEnv, n: GwName, status: GatewayStatus) {
  const label = GatewayStatus[status];
  banner(`Proposal: set Gateway ${n} to ${label}`);
  await runLifecycle(
    env,
    [
      {
        target: env.dao.addresses.gatewayRegistry,
        calldata: encodeSetGatewayStatus(
          env.web3,
          env.gwKeys[n],
          status,
          `demo: ${label}`,
        ),
      },
    ],
    `Demo: ${label} gateway ${n} [${Date.now()}]`,
    logPhase,
  );
  if (!env.gms) return ok("proposal executed");
  const ms = await waitForGatewayStatus(env, env.gwKeys[n], status);
  ok(
    `every GovernanceManager cache shows ${n} = ${c.bold(label)} (${ms} ms after execution)`,
  );
}

// accept camelCase too: proposePolicyParameter -> propose-policy-parameter
const normCmd = (s: string) =>
  s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());

async function main() {
  const argv = process.argv.slice(2);
  const lite = argv.includes("--lite");
  const [cmd, ...args] = argv.filter((a) => a !== "--lite");

  let env: DemoEnv | undefined;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const shutdown = async () => {
    rl.close();
    await env?.teardown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  const run = async (name: string, a: string[]) => {
    const cmdName = normCmd(name);
    const f = commands[cmdName];
    try {
      if (cmdName === "stop") {
        if (!env) throw new Error("nothing is running");
        banner("Stop: GovernanceManagers, gateways, databases, ledgers");
        const t0 = Date.now();
        const stopping = env;
        env = undefined;
        await stopping.teardown();
        ok(
          `stopped in ${Date.now() - t0} ms, run 'start-ledgers' to start again`,
        );
      } else if (cmdName === "start-ledgers") {
        if (env) throw new Error("ledgers already running");
        const isLite = lite || a[0] === "lite";
        banner(`Start ledgers: Ethereum${isLite ? "" : " + Besu"}`);
        const t0 = Date.now();
        env = await bootEnv({ lite: isLite });
        ok(`ledgers up in ${Date.now() - t0} ms`);
      } else if (cmdName === "show-config") {
        // before start-ledgers there are no accounts/keys yet: show the raw template
        const template = !env || a[0] === "template";
        banner(template ? CONFIG_TEMPLATE : CONFIG_FILE);
        console.log(
          template
            ? fs.readFileSync(CONFIG_TEMPLATE, "utf8")
            : JSON.stringify(env!.config, null, 2),
        );
      } else if (!f) USAGE.forEach((l) => info(l));
      else if (!env)
        throw new Error("ledgers not started, run 'start-ledgers' first");
      else await f(env, a);
    } catch (e: any) {
      bad(e?.message ?? String(e));
    }
  };

  if (cmd) {
    await run("start-ledgers", []);
    if (!["start-ledgers", "deploy-dao"].includes(normCmd(cmd)))
      await run("deploy-dao", []);
    if (normCmd(cmd) === "start-ledgers") return shutdown();
    await run(cmd, args);
    return shutdown();
  }
  banner(
    "IChainGov demo ready. Type 'start-ledgers' then 'deploy-dao' ('help' to list commands).",
  );
  for (;;) {
    const [name, ...a] = (await rl.question(c.bold(c.cyan("\nichaingov> "))))
      .trim()
      .split(/\s+/);
    if (name === "exit" || name === "quit") return shutdown();
    if (name) await run(name, a);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
