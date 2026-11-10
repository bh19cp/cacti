import {
  type ILoggerOptions,
  type LogLevelDesc,
} from "@hyperledger/cactus-common";

import { SATPLoggerProvider as LoggerProvider } from "../../core/satp-logger-provider";
import type { SATPLogger as Logger } from "../../core/satp-logger";

import { PluginRegistry } from "@hyperledger/cactus-core";
import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";
import { LedgerType } from "@hyperledger/cactus-core-api";

import { v4 as uuidv4 } from "uuid";
import { stringify as safeStableStringify } from "safe-stable-stringify";

import { INetworkOptions } from "../bridge/bridge-types";
import { MonitorService } from "../../services/monitoring/monitor";

import { DeployOracleError, UnsupportedNetworkError } from "../common/errors";

import { OracleAbstract } from "./oracle-abstract";

import { IOracleEVMOptions, OracleEVM } from "./implementations/oracle-evm";

import { IOracleBesuOptions, OracleBesu } from "./implementations/oracle-besu";

import {
  IOracleFabricOptions,
  OracleFabric,
} from "./implementations/oracle-fabric";

export interface IOracleFactoryOptions {
  logLevel?: LogLevelDesc;
  monitorService: MonitorService;
}

export class OracleFactory {
  public static readonly CLASS_NAME = "OracleFactory";

  public static create(
    oracleNetworkOptions: INetworkOptions,
    options: IOracleFactoryOptions,
  ): OracleAbstract {
    const fnTag = `${OracleFactory.CLASS_NAME}#create()`;

    const logLevel: LogLevelDesc = options.logLevel ?? "INFO";

    const loggerOptions: ILoggerOptions = {
      level: logLevel,
      label: OracleFactory.CLASS_NAME,
    };

    const logger: Logger = LoggerProvider.getOrCreate(
      loggerOptions,
      options.monitorService,
    );

    try {
      logger.debug(`${fnTag}: Creating Oracle...`);
      logger.debug(
        `${fnTag}: Oracle Network Options: ${JSON.stringify(
          oracleNetworkOptions,
        )}`,
      );

      switch (oracleNetworkOptions.networkIdentification.ledgerType) {
        case LedgerType.Besu1X:
        case LedgerType.Besu2X: {
          logger.debug(`${fnTag}: Creating Besu Oracle...`);

          const besuNetworkOptions = oracleNetworkOptions as IOracleBesuOptions;

          return new OracleBesu({
            ...besuNetworkOptions,
            connectorOptions: {
              ...besuNetworkOptions.connectorOptions,
              instanceId: uuidv4(),
              pluginRegistry: new PluginRegistry({
                plugins: [],
              }),
              logLevel,
            },
            monitorService: options.monitorService,
            logLevel,
          });
        }
        case LedgerType.Ethereum: {
          logger.debug(`${fnTag}: Creating Ethereum Oracle...`);

          const ethereumNetworkOptions =
            oracleNetworkOptions as IOracleEVMOptions;

          return new OracleEVM({
            ...ethereumNetworkOptions,
            connectorOptions: {
              ...ethereumNetworkOptions.connectorOptions,
              instanceId: uuidv4(),
              pluginRegistry: new PluginRegistry({
                plugins: [],
              }),
              logLevel,
            },
            monitorService: options.monitorService,
            logLevel,
          });
        }
        case LedgerType.Fabric2: {
          logger.debug(`${fnTag}: Creating Fabric Oracle...`);

          const fabricOptions =
            oracleNetworkOptions as Partial<IOracleFabricOptions>;

          if (!fabricOptions.userIdentity) {
            throw new DeployOracleError(
              `${fnTag}: User Identity is required for Fabric network`,
            );
          }

          const keychainEntryKeyBridge = "bridgeKey";

          const fabricKeychain = new PluginKeychainMemory({
            instanceId: uuidv4(),
            keychainId: uuidv4(),
            logLevel,
            backend: new Map([
              [
                keychainEntryKeyBridge,
                JSON.stringify(fabricOptions.userIdentity),
              ],
            ]),
          });

          const fabricNetworkOptions = {
            ...oracleNetworkOptions,
            connectorOptions: {
              ...fabricOptions.connectorOptions,
              instanceId: uuidv4(),
              pluginRegistry: new PluginRegistry({
                plugins: [fabricKeychain],
              }),
              logLevel,
            },
            signingCredential: {
              keychainId: fabricKeychain.getKeychainId(),
              keychainRef: keychainEntryKeyBridge,
            },
          } as IOracleFabricOptions;

          return new OracleFabric({
            ...fabricNetworkOptions,
            logLevel,
            monitorService: options.monitorService,
          });
        }
        default:
          throw new UnsupportedNetworkError(
            `${fnTag}: Unsupported ledger type ${oracleNetworkOptions.networkIdentification.ledgerType}`,
          );
      }
    } catch (error) {
      logger.error(
        `${fnTag}: Failed creating oracle for network ${safeStableStringify(
          oracleNetworkOptions.networkIdentification,
        )}: ${error}`,
      );

      throw new DeployOracleError(error);
    }
  }
}
