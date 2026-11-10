// Geth console script (ES5): prints governance events as they are mined.
//   docker cp geth-watch.js <geth-container>:/tmp/geth-watch.js
//   docker exec -it <geth-container> geth attach --preload /tmp/geth-watch.js /root/data/geth.ipc
var EVENTS = {
  "0x7d84a6263ae0d98d3329bd7b46bb4e8d6f98cd35a7adb45c274c8b7fd5ebd5e0": "ProposalCreated",
  "0xb8e138887d0aa13bab447e82de9d5c1777041ecd21ca36ba824ff1e6c07ddda4": "VoteCast",
  "0x9a2e42fd6722813d69113e7d0079d3d940171428df7373df9c7f7617cfda2892": "ProposalQueued",
  "0x712ae1383f79ac853f8d882153778e0260ef8f03b504e2866e0593e04d2b291f": "ProposalExecuted",
  "0x7b10a691b0d9320a60f61a486f6d14430f76d79fabb582e9b9f1c1f545cf3afa": "GatewayStatusChanged",
  "0x83ba59f61577249be5e1d5d48f41b4be728e3ddb0c1b04c988d7ce5205ebb8ec": "ParameterUpdated",
};

function printLog(l) {
  var name = EVENTS[l.topics[0]];
  if (!name) return;
  var line = "block " + web3.toDecimal(l.blockNumber) + "  " + name + "  contract " + l.address;
  if (name.indexOf("Proposal") === 0 || name === "VoteCast") {
    var id = "0x" + l.data.slice(2, 66);
    line += "  proposal " + web3.toBigNumber(id).toString(10).slice(0, 12) + "…";
  }
  if (name === "VoteCast") line += "  voter 0x" + l.topics[1].slice(26);
  console.log(line + "  tx " + l.transactionHash);
}

eth.getLogs({ fromBlock: "earliest", toBlock: "latest", topics: [Object.keys(EVENTS)] }).forEach(printLog);
eth.filter({ fromBlock: "latest", topics: [Object.keys(EVENTS)] }).watch(function (err, l) {
  if (!err) printLog(l);
});
console.log("watching governance events (Ctrl-D to quit)");
