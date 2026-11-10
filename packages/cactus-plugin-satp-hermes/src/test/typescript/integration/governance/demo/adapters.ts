import { sleep } from "./ui";
import type { DemoEnv, GwName } from "./env";
import {
  POLICY_KEY_TO_FIELD,
  PolicyKey,
  RuntimePolicy,
} from "../../../../../main/typescript/governance/governance-policy-config";

const normKey = (k: string) =>
  (k.startsWith("0x") ? k : "0x" + k).toLowerCase();

export function readRuntimeParam(
  env: DemoEnv,
  n: GwName,
  key: string,
): string | undefined {
  const field = POLICY_KEY_TO_FIELD[key as PolicyKey];
  if (!field) throw new Error(`unknown policy key: ${key}`);
  const v = env.gms![n].getRuntimePolicy()[field as keyof RuntimePolicy];
  return v === undefined ? undefined : String(v);
}

export function readCachedGatewayStatus(
  env: DemoEnv,
  n: GwName,
  pubKey: string,
): number | undefined {
  return env.gms![n].getCachedGatewayStatus(normKey(pubKey));
}

export function readGatewayStatusCache(
  env: DemoEnv,
  n: GwName,
): Map<string, number> {
  return (env.gms![n] as any).gatewayStatusCache;
}

export function letterOf(env: DemoEnv, pubKey: string): GwName | undefined {
  const k = normKey(pubKey);
  return (Object.keys(env.gwKeys) as GwName[]).find(
    (n) => normKey(env.gwKeys[n]) === k,
  );
}

export async function waitForRuntimeParam(
  env: DemoEnv,
  key: string,
  expected: string,
) {
  const t0 = Date.now();
  const names = Object.keys(env.gms!) as GwName[];
  while (!names.every((n) => readRuntimeParam(env, n, key) === expected))
    await sleep(25);
  return Date.now() - t0;
}

export async function waitForGatewayStatus(
  env: DemoEnv,
  pubKey: string,
  expected: number,
) {
  const t0 = Date.now();
  const names = Object.keys(env.gms!) as GwName[];
  while (
    !names.every((n) => readCachedGatewayStatus(env, n, pubKey) === expected)
  )
    await sleep(25);
  return Date.now() - t0;
}

export function readSessionLockExpiration(
  env: DemoEnv,
  n: GwName,
  sessionId: string,
): { side: "client" | "server"; value: string } | undefined {
  const manager = (env.gateways![n].BLODispatcherInstance as any)?.manager;
  const session = manager?.getSession(sessionId);
  if (!session) return undefined;
  if (session.hasClientSessionData())
    return {
      side: "client",
      value: String(session.getClientSessionData().lockExpirationTime),
    };
  if (session.hasServerSessionData())
    return {
      side: "server",
      value: String(session.getServerSessionData().lockExpirationTime),
    };
  return undefined;
}
