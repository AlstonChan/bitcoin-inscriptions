import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { BIP32Factory } from "bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Buffer } from "node:buffer";

import { derivePathFromIndex, makeTaprootFinalizer } from "./lib/bitcoinUtils.js";
import { rpcCall as rawRpcCall } from "./lib/bitcoinUtils.js";

// Initialize ECC library
bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

const NETWORK = bitcoin.networks.regtest;

// Bitcoin Core RPC configuration
const RPC_USER = "mempool";
const RPC_PASSWORD = "mempool";
const RPC_HOST = "localhost";
const RPC_PORT = 18443;

// Random regtest address to receive the inscription
const RECIPIENT_ADDRESS =
  "bcrt1pdr5s4367f5ex7n4hfka5k7xezraz3elg3ulmmqwedfq4e4qtp8asn8scf5";
// The UTXO to spend
const PREV_TXID = "d4026229d0164a80ed3b95b762ebd12537391f0c14dc060043625de452c109b5";
// THe vout of the UTXO
const PREV_VOUT = 0;
// Mnemonic for key derivation, used for address generation for inscription address
const MNEMONIC =
  "merge access museum power churn clarify gauge correct alpha fix legal senior";

/**
 * Makes an RPC call to Bitcoin Core
 * @param method - RPC method name
 * @param params - RPC method parameters
 * @returns RPC response result
 */
async function rpcCall(method: string, params: any[] = []): Promise<any> {
  return await rawRpcCall(
    `http://${RPC_HOST}:${RPC_PORT}/`,
    RPC_USER,
    RPC_PASSWORD,
    method,
    params
  );
}

/**
 * Creates and signs a Taproot transaction with script path spending
 * @throws {Error} If verification fails
 */
async function createAndBroadcastTx(): Promise<void> {
  // Test RPC connection
  console.log("Testing RPC connection...");
  const blockchainInfo = await rpcCall("getblockchaininfo");
  console.log(`Connected to Bitcoin Core (chain: ${blockchainInfo.chain})`);
  console.log(`Blocks: ${blockchainInfo.blocks}`);

  // Verify the UTXO exists and get its details
  console.log("\nVerifying UTXO...");
  const utxoInfo = await rpcCall("gettxout", [PREV_TXID, PREV_VOUT, true]);

  if (!utxoInfo) {
    throw new Error(
      `UTXO not found: ${PREV_TXID}:${PREV_VOUT} (already spent or doesn't exist)`
    );
  }

  console.log(`UTXO found:`);
  console.log(
    `UTXO Value: ${utxoInfo.value} BTC (${Math.round(utxoInfo.value * 100_000_000)} sats)`
  );
  console.log(`UTXO ScriptPubKey: ${utxoInfo.scriptPubKey.hex}`);
  console.log(`UTXO Address: ${utxoInfo.scriptPubKey.address || "N/A"}`);

  const actualValue = BigInt(Math.round(utxoInfo.value * 100_000_000));
  console.log(`Using actual UTXO value: ${actualValue}`);

  // Get seed from mnemonic
  const seed = mnemonicToSeedSync(MNEMONIC);
  const root = bip32.fromSeed(seed, NETWORK);

  // Generate keys
  const internalKey = derivePathFromIndex(root, 0);
  const tweakKey = internalKey.tweak(
    bitcoin.crypto.taggedHash(
      "TapTweak",
      Buffer.from(bitcoin.toXOnly(internalKey.publicKey))
    )
  );

  // Create tapscript
  const tapscriptChunks = [
    Buffer.from(Buffer.from(bitcoin.toXOnly(tweakKey.publicKey)).toString("hex"), "hex"),
    bitcoin.opcodes.OP_CHECKSIG,
    bitcoin.opcodes.OP_0,
    bitcoin.opcodes.OP_IF,
    Buffer.from("ord", "utf8"),
    1, // Push bytes of length 1
    1, // Push the value 1
    Buffer.from("text/plain;charset=utf-8", "utf8"),
    bitcoin.opcodes.OP_0,
    Buffer.from("Hello, World!", "utf8"),
    bitcoin.opcodes.OP_ENDIF,
  ];
  const tapscript = bitcoin.script.compile(tapscriptChunks);
  const tapscriptRedeem = {
    output: tapscript,
    redeemVersion: 192,
  };
  const scriptTree = { output: tapscript };

  // Create P2TR payment with script tree (automatically tweaks the internal key)
  const p2tr = bitcoin.payments.p2tr({
    internalPubkey: Buffer.from(bitcoin.toXOnly(tweakKey.publicKey)),
    redeem: tapscriptRedeem,
    network: NETWORK,
    scriptTree,
  });

  console.log("\nInscription Address:", p2tr.address);
  const ourScriptHex = Buffer.from(p2tr.output!).toString("hex");
  console.log("ScriptPubKey (hex):", ourScriptHex);

  // Verify the UTXO scriptPubKey matches our P2TR output
  const utxoScriptHex = utxoInfo.scriptPubKey.hex;

  if (utxoScriptHex !== ourScriptHex) {
    console.error("\nUTXO scriptPubKey doesn't match!");
    console.error(`Expected: ${ourScriptHex}`);
    console.error(`Found:    ${utxoScriptHex}`);
    throw new Error(
      "The UTXO you're trying to spend was not created with this script/address"
    );
  }
  console.log("ScriptPubKey matches!");

  // Create control block for script path spending
  const controlBlock = p2tr.witness?.[p2tr.witness.length - 1];

  // Create PSBT
  const psbt = new bitcoin.Psbt({ network: NETWORK });

  psbt.addInput({
    hash: PREV_TXID,
    index: PREV_VOUT,
    witnessUtxo: {
      script: p2tr.output!,
      value: actualValue,
    },
    tapLeafScript: [
      {
        leafVersion: tapscriptRedeem.redeemVersion,
        script: tapscriptRedeem.output,
        controlBlock: controlBlock!,
      },
    ],
  });
  psbt.addOutput({
    address: RECIPIENT_ADDRESS,
    value: 10000n,
  });

  // Add change output - return remaining funds back to our address
  const fee = 1000n; // 1000 sats fee
  const changeAmount = actualValue - 10000n - fee;

  if (changeAmount > 0n) {
    psbt.addOutput({
      address: p2tr.address!, // Send change back to our taproot address
      value: changeAmount,
    });
    console.log(`\nAdding change output: ${changeAmount} sats back to ${p2tr.address}`);
  }

  // Sign the input
  psbt.signInput(0, tweakKey);

  // Verify signatures before finalizing
  const isValid = psbt.validateSignaturesOfInput(0, (pubkey, msgHash, signature) => {
    return ecc.verifySchnorr(msgHash, pubkey, signature);
  });

  if (!isValid) throw new Error("Signature verification failed");
  console.log("✓ Signature verification passed");

  psbt.finalizeInput(0, makeTaprootFinalizer(tapscript, controlBlock!));

  const tx = psbt.extractTransaction();
  const txHex = tx.toHex();

  console.log("\nTransaction hexadecimal:");
  console.log(txHex);

  // Broadcast transaction
  console.log("\nBroadcasting transaction...");
  const txid = await rpcCall("sendrawtransaction", [txHex]);

  console.log("Transaction broadcast successful!");
  console.log(`TXID: ${txid}`);

  // Get transaction details
  console.log("Fetching transaction details...");
  const txInfo = await rpcCall("getrawtransaction", [txid, true]);
  console.log(`Size: ${txInfo.size} bytes`);
  console.log(`Virtual size: ${txInfo.vsize} vbytes`);
  console.log(`Confirmations: ${txInfo.confirmations || 0}`);
}

// Execute the main function
createAndBroadcastTx().catch(console.error);

// RESULTS:
//
// Testing RPC connection...
// Connected to Bitcoin Core (chain: regtest)
// Blocks: 109
//
// Verifying UTXO...
// UTXO found:
// UTXO Value: 2 BTC (200000000 sats)
// UTXO ScriptPubKey: 512071508a5ceeb77409271d4f51abb7cd5c4731039f1cd2b8eb6b2765ed49cb095b
// UTXO Address: bcrt1pw9gg5h8wka6qjfcafag6hd7dt3rnzqulrnft36mtyaj76jwtp9dstl4625
// Using actual UTXO value: 200000000
//
// Inscription Address: bcrt1pw9gg5h8wka6qjfcafag6hd7dt3rnzqulrnft36mtyaj76jwtp9dstl4625
// ScriptPubKey (hex): 512071508a5ceeb77409271d4f51abb7cd5c4731039f1cd2b8eb6b2765ed49cb095b
// ScriptPubKey matches!
//
// Adding change output: 199989000 sats back to bcrt1pw9gg5h8wka6qjfcafag6hd7dt3rnzqulrnft36mtyaj76jwtp9dstl4625
// Signature verification passed
//
// Transaction hexadecimal:
// 02000000000101b509c152e45d62430006dc140c1f393725d1eb62b7953bed804a16d0296202d40000000000ffffffff02102700000000000022512068e90ac75e4d326f4eb74dbb4b78d910fa28e7e88f3fbd81d96a415cd40b09fb0897eb0b0000000022512071508a5ceeb77409271d4f51abb7cd5c4731039f1cd2b8eb6b2765ed49cb095b0340887d1dc9ad80491b1befa8652e63934ff5c24f8944e51e6f74fb1259e18b6ba568af51cbfa9d226ff7c4cca7eda0f6dbca2edb8af26be36e48460cfca68886ac532071f53c0dcfe234e46cc1a0373ec153c773a11b3a60f9ebb2f078858bd0893a36ac0063036f7264010118746578742f706c61696e3b636861727365743d7574662d38000d48656c6c6f2c20576f726c64216821c171f53c0dcfe234e46cc1a0373ec153c773a11b3a60f9ebb2f078858bd0893a3600000000
//
// Broadcasting transaction...
// Transaction broadcast successful!
// TXID: 04e47e11bd1024f22c7fdfff6f0ee8ebbb0506f2d5f206bd9d57bb78fd0dd3c9
//
// Fetching transaction details...
// Size: 323 bytes
// Virtual size: 184 vbytes
// Confirmations: 0
