import { Configuration, LedgerType } from "@hyperledger/cactus-core-api";
import { TokenType as TokenTypeMain } from "../../../../../main/typescript/generated/proto/cacti/satp/v02/common/message_pb";
import {
  AdminApi,
  GetApproveAddressApi,
  TokenType,
  TransactionApi,
} from "../../../../../main/typescript";
import {
  BesuTestEnvironment,
  EthereumTestEnvironment,
} from "../../../test-utils";
import { ETH_NETWORK_ID_2, DemoEnv, GwName } from "./env";

const AMOUNT = "50";
const TERMINAL = ["DONE", "FAILED", "INVALID"];

function side(
  env: DemoEnv,
  n: GwName,
): {
  ledger: BesuTestEnvironment | EthereumTestEnvironment;
  network: { id: string; ledgerType: LedgerType };
} {
  if (n === "A") return { ledger: env.besuEnv!, network: env.besuEnv!.network };
  if (n === "B")
    return { ledger: env.ethereumEnv, network: env.ethereumEnv.network };
  return {
    ledger: env.ethereumEnv,
    network: { id: ETH_NETWORK_ID_2, ledgerType: LedgerType.Ethereum },
  };
}

const approveAddress = async (
  env: DemoEnv,
  n: GwName,
  network: { id: string; ledgerType: LedgerType },
) =>
  (
    await new GetApproveAddressApi(
      new Configuration({ basePath: env.gateways![n].getAddressOApiAddress() }),
    ).getApproveAddress(network, TokenType.Fungible)
  ).data.approveAddress!;

export async function runTransfer(env: DemoEnv, from: GwName, to: GwName) {
  const src = side(env, from);
  const dst = side(env, to);
  try {
    await src.ledger.mintTokens(AMOUNT, TokenTypeMain.NONSTANDARD_FUNGIBLE);
    const srcBridge = await approveAddress(env, from, src.network);
    await src.ledger.giveRoleToBridge(srcBridge);
    await src.ledger.approveAssets(
      srcBridge,
      AMOUNT,
      TokenTypeMain.NONSTANDARD_FUNGIBLE,
    );
    await dst.ledger.giveRoleToBridge(
      await approveAddress(env, to, dst.network),
    );

    const basePath = env.gateways![from].getAddressOApiAddress();
    const t0 = Date.now();
    const res = await new TransactionApi(
      new Configuration({ basePath }),
    ).transact({
      contextID: "demo",
      sourceAsset: {
        ...src.ledger.defaultAsset,
        networkId: src.network,
        amount: AMOUNT,
      },
      receiverAsset: {
        ...dst.ledger.defaultAsset,
        networkId: dst.network,
        amount: AMOUNT,
      },
    });
    const admin = new AdminApi(new Configuration({ basePath }));
    for (;;) {
      await new Promise((r) => setTimeout(r, 500));
      const s = (await admin.getStatus(res.data.sessionID)).data;
      if (s.status === "DONE")
        return {
          ok: true as const,
          ms: Date.now() - t0,
          sessionId: res.data.sessionID,
        };
      if (TERMINAL.includes(s.status))
        return {
          ok: false as const,
          sessionId: res.data.sessionID,
          reason: `${s.status}${s.substatus ? ` (${s.substatus})` : ""}`,
        };
    }
  } catch (e: any) {
    const body = e?.response?.data;
    return {
      ok: false as const,
      sessionId: undefined,
      reason: body ? JSON.stringify(body) : e?.message ?? String(e),
    };
  }
}
