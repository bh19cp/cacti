# governance-demo-dao

DAO configuration used by the governance demo CLI.

- `dao.config.template.json` — the DAO config (same format as `ichaingov-contract-generator`'s
  `config.json`). Org addresses and gateway public keys are placeholders, because they only
  exist once the demo has started: `${ORG_A_ADDRESS}`, `${GATEWAY_A_PUBLIC_KEY}`, ... (A, B, C).
- `config.json` — written by `start-ledgers`: the template filled with that run's org accounts and
  gateway keys. `deploy-dao` deploys exactly this config to the Geth ledger.

Only use `protocolParameters` keys the gateways' runtime policy understands:
`satp.version`, `satp.session.lockExpirationTime`, `signingAlgorithm`, `claimFormat`.
