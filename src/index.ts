import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { BIP32Factory } from "bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { select, input, confirm } from "@inquirer/prompts";

import {
  derivePathFromIndex,
  estimateTxWeight,
  generateTapscriptChunks,
  makeTaprootFinalizer,
} from "./lib/bitcoinUtils.js";
import { rpcCall as rawRpcCall } from "./lib/bitcoinUtils.js";
import { getContentType } from "./lib/misc.js";

// Initialize ECC library
bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

const NETWORK = bitcoin.networks.regtest;

// Bitcoin Core RPC configuration
const RPC_USER = "mempool";
const RPC_PASSWORD = "mempool";
const RPC_HOST = "localhost";
const RPC_PORT = 18443;

// Mnemonic for key derivation
const MNEMONIC =
  "merge access museum power churn clarify gauge correct alpha fix legal senior";

// Minimum inscription amount (in sats)
const MIN_INSCRIPTION_AMOUNT = 523n;

// Dust limit for Taproot outputs
const DUST_LIMIT = 330n;

// Asset directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.resolve(__filename, "../../");
const ASSETS_DIR = path.join(__dirname, "assets");

/**
 * Makes an RPC call to Bitcoin Core
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
 * List available assets in the assets directory
 */
function listAssets(): string[] {
  if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    return [];
  }
  return fs.readdirSync(ASSETS_DIR).filter((file) => {
    const filePath = path.join(ASSETS_DIR, file);
    return fs.statSync(filePath).isFile();
  });
}

/**
 * Get recommended fee rate from Bitcoin Core
 */
async function getFeeRate(): Promise<number> {
  try {
    // Try to get smart fee estimate for 1 block
    const feeEstimate = await rpcCall("estimatesmartfee", [1]);
    if (feeEstimate.feerate) {
      // Convert BTC/kB to sats/vB
      return Math.ceil((feeEstimate.feerate * 100_000_000) / 1000);
    }
  } catch (error) {
    console.log("Could not get fee estimate, using default");
  }
  // Default to 1 sat/vB for regtest
  return 1;
}

/**
 * Create taproot inscription address
 */
function createInscriptionAddress(
  content: Buffer,
  contentType: string
): {
  address: string;
  p2tr: bitcoin.Payment;
  tweakKey: any;
  tapscript: Uint8Array<ArrayBufferLike>;
  controlBlock: Uint8Array<ArrayBufferLike>;
} {
  const seed = mnemonicToSeedSync(MNEMONIC);
  const root = bip32.fromSeed(seed, NETWORK);

  const internalKey = derivePathFromIndex(root, 0);
  const tweakKey = internalKey.tweak(
    bitcoin.crypto.taggedHash(
      "TapTweak",
      Buffer.from(bitcoin.toXOnly(internalKey.publicKey))
    )
  );

  // Generate tapscript chunks with proper chunking for large content
  const tapscriptChunks = generateTapscriptChunks(
    tweakKey,
    content,
    contentType,
    undefined,
    undefined,
    false
  );

  const tapscript = bitcoin.script.compile(tapscriptChunks);
  const tapscriptRedeem = {
    output: tapscript,
    redeemVersion: 192,
  };
  const scriptTree = { output: tapscript };

  const p2tr = bitcoin.payments.p2tr({
    internalPubkey: Buffer.from(bitcoin.toXOnly(tweakKey.publicKey)),
    redeem: tapscriptRedeem,
    network: NETWORK,
    scriptTree,
  });

  const controlBlock = p2tr.witness?.[p2tr.witness.length - 1];

  return {
    address: p2tr.address!,
    p2tr,
    tweakKey,
    tapscript,
    controlBlock: controlBlock!,
  };
}

/**
 * Check if address has received funds using scantxoutset
 */
async function checkAddressFunds(
  address: string
): Promise<{ received: boolean; utxos: any[] }> {
  try {
    // Use scantxoutset to scan for UTXOs at the address
    const result = await rpcCall("scantxoutset", ["start", [`addr(${address})`]]);

    if (!result || !result.unspents) {
      return { received: false, utxos: [] };
    }

    // Transform the unspents into a format similar to listunspent
    const utxos = result.unspents.map((utxo: any) => ({
      txid: utxo.txid,
      vout: utxo.vout,
      amount: utxo.amount,
      scriptPubKey: utxo.scriptPubKey,
      height: utxo.height,
    }));

    return {
      received: utxos.length > 0,
      utxos: utxos,
    };
  } catch (error) {
    console.error("Error checking address funds:", error);
    return { received: false, utxos: [] };
  }
}

/**
 * Wait for payment to inscription address
 */
async function waitForPayment(
  address: string,
  requiredAmount: bigint
): Promise<{ txid: string; vout: number; amount: bigint }> {
  console.log(`\n${"=".repeat(60)}`);
  console.log("SEND BITCOIN TO THIS ADDRESS:");
  console.log(`\n${address}\n`);
  console.log(`Required Amount: ${requiredAmount} sats`);
  console.log(`${"=".repeat(60)}\n`);

  while (true) {
    const { received, utxos } = await checkAddressFunds(address);

    if (received && utxos.length > 0) {
      // Find UTXO with sufficient amount
      const suitableUtxo = utxos.find((utxo: any) => {
        const amount = BigInt(Math.round(utxo.amount * 100_000_000));
        return amount >= requiredAmount;
      });

      if (suitableUtxo) {
        const amount = BigInt(Math.round(suitableUtxo.amount * 100_000_000));
        console.log(`\nPayment received!`);
        console.log(`TXID: ${suitableUtxo.txid}`);
        console.log(`Amount: ${amount} sats`);
        return {
          txid: suitableUtxo.txid,
          vout: suitableUtxo.vout,
          amount,
        };
      }
    }

    const action = await select({
      message: "Payment not detected yet. What would you like to do?",
      choices: [
        { name: "Check again", value: "check" },
        { name: "Exit", value: "exit" },
      ],
    });

    if (action === "exit") {
      console.log("Exiting...");
      process.exit(0);
    }
  }
}

/**
 * Create and broadcast inscription transaction
 */
async function createInscriptionTx(
  inscriptionData: {
    address: string;
    p2tr: bitcoin.Payment;
    tweakKey: any;
    tapscript: Uint8Array<ArrayBufferLike>;
    controlBlock: Uint8Array<ArrayBufferLike>;
  },
  utxo: { txid: string; vout: number; amount: bigint },
  totalRequired: bigint,
  recipientAddress: string
): Promise<string> {
  const { p2tr, tweakKey, tapscript, controlBlock } = inscriptionData;

  // Create PSBT
  const psbt = new bitcoin.Psbt({ network: NETWORK });

  const tapscriptRedeem = {
    output: tapscript,
    redeemVersion: 192,
  };

  psbt.addInput({
    hash: utxo.txid,
    index: utxo.vout,
    witnessUtxo: {
      script: p2tr.output!,
      value: utxo.amount,
    },
    tapLeafScript: [
      {
        leafVersion: tapscriptRedeem.redeemVersion,
        script: tapscriptRedeem.output,
        controlBlock: controlBlock,
      },
    ],
  });

  // Add output to recipient
  psbt.addOutput({
    address: recipientAddress,
    value: MIN_INSCRIPTION_AMOUNT,
  });

  // Calculate change
  const actualFee = totalRequired - MIN_INSCRIPTION_AMOUNT - DUST_LIMIT - 200n;
  const changeAmount = utxo.amount - MIN_INSCRIPTION_AMOUNT - actualFee;

  // Only create change output if it's above dust limit
  if (changeAmount >= DUST_LIMIT) {
    psbt.addOutput({
      address: inscriptionData.address,
      value: changeAmount,
    });
    console.log(`\nChange: ${changeAmount} sats (back to inscription address)`);
  } else if (changeAmount > 0n) {
    // Change is below dust limit, add it to the fee instead
    console.log(
      `\nChange (${changeAmount} sats) below dust limit (${DUST_LIMIT} sats), adding to fee`
    );
  }

  // Sign and finalize
  psbt.signInput(0, tweakKey);

  const isValid = psbt.validateSignaturesOfInput(0, (pubkey, msgHash, signature) => {
    return ecc.verifySchnorr(msgHash, pubkey, signature);
  });

  if (!isValid) throw new Error("Signature verification failed");
  console.log("Signature verified");

  psbt.finalizeInput(0, makeTaprootFinalizer(tapscript, controlBlock));

  const tx = psbt.extractTransaction();
  const txHex = tx.toHex();

  // Broadcast
  console.log("\nBroadcasting transaction...");
  const txid = await rpcCall("sendrawtransaction", [txHex]);

  return txid;
}

/**
 * Main interactive flow
 */
async function main() {
  console.log("\nBitcoin Ordinals Inscription Tool\n");

  // Test RPC connection
  try {
    const blockchainInfo = await rpcCall("getblockchaininfo");
    console.log(`Connected to Bitcoin Core (${blockchainInfo.chain})`);
    console.log(`Current block height: ${blockchainInfo.blocks}\n`);
  } catch (error) {
    console.error("Could not connect to Bitcoin Core RPC");
    console.error("Please ensure Bitcoin Core is running and RPC is configured");
    process.exit(1);
  }

  // Step 1: Choose content type
  const contentType = await select({
    message: "What would you like to inscribe?",
    choices: [
      { name: "Text", value: "text" },
      { name: "Asset (file)", value: "asset" },
    ],
  });

  let content: Buffer;
  let mimeType: string;

  if (contentType === "text") {
    // Step 2a: Get text input
    const textContent = await input({
      message: "Enter the text to inscribe:",
      validate: (value) => (value.length > 0 ? true : "Text cannot be empty"),
    });

    content = Buffer.from(textContent, "utf8");
    mimeType = "text/plain;charset=utf-8";
    console.log(`\nText content: ${textContent.length} characters`);
  } else {
    // Step 2b: Choose asset file
    const assets = listAssets();

    if (assets.length === 0) {
      console.log(`\nNo assets found in ${ASSETS_DIR}`);
      console.log("Please add files to the assets directory and try again.");
      process.exit(1);
    }

    const assetFile = await select({
      message: "Choose an asset file:",
      choices: assets.map((file) => ({ name: file, value: file })),
    });

    const assetPath = path.join(ASSETS_DIR, assetFile);
    content = fs.readFileSync(assetPath);
    mimeType = getContentType(assetFile);

    console.log(`\nAsset: ${assetFile}`);
    console.log(`Size: ${content.length} bytes`);
    console.log(`MIME type: ${mimeType}`);
  }

  // Step 3: Get recipient address
  const recipientAddress = await input({
    message: "Enter recipient address for the inscription:",
    default: "bcrt1pdr5s4367f5ex7n4hfka5k7xezraz3elg3ulmmqwedfq4e4qtp8asn8scf5",
    validate: (value) => {
      try {
        bitcoin.address.toOutputScript(value, NETWORK);
        return true;
      } catch {
        return "Invalid address";
      }
    },
  });

  // Step 4: Ask for optional advanced features
  //   let metadata: string | undefined;
  //   let parentID: string | undefined;
  //   let brotliCompress = false;

  //   const useAdvanced = await confirm({
  //     message: "Use advanced features (metadata, parent inscription, compression)?",
  //     default: false,
  //   });

  //   if (useAdvanced) {
  //     const metadataInput = await input({
  //       message: "Enter metadata (hex string, or press Enter to skip):",
  //       default: "",
  //     });
  //     if (metadataInput) {
  //       metadata = metadataInput;
  //     }

  //     const parentIDInput = await input({
  //       message: "Enter parent inscription ID (or press Enter to skip):",
  //       default: "",
  //     });
  //     if (parentIDInput) {
  //       parentID = parentIDInput;
  //     }

  //     brotliCompress = await confirm({
  //       message: "Use Brotli compression?",
  //       default: false,
  //     });
  //   }

  // Step 5: Create inscription address and calculate fees
  console.log("\nCreating inscription address...");
  const inscriptionData = createInscriptionAddress(content, mimeType);

  // Check transaction weight limit BEFORE proceeding
  const txWeight = estimateTxWeight(content.length);

  console.log(`\nTransaction Weight Analysis:`);
  console.log(`Weight Units: ${txWeight.weightUnits.toLocaleString()} WU`);
  console.log(`Virtual Size: ${txWeight.vbytes.toLocaleString()} vbytes`);
  console.log(`Limit: 400,000 WU`);

  if (txWeight.exceedsLimit) {
    console.log("\nERROR: Transaction exceeds 400,000 weight unit limit!");
    console.log(`Your transaction: ${txWeight.weightUnits.toLocaleString()} WU`);
    console.log(`Limit: 400,000 WU`);
    console.log(`Exceeded by: ${(txWeight.weightUnits - 400_000).toLocaleString()} WU`);
    process.exit(1);
  }

  console.log("Transaction size is within limits\n");

  const feeRate = await getFeeRate();
  const estimatedFee = BigInt(txWeight.vbytes * feeRate);

  // Add extra buffer for fee estimation inaccuracies
  const feeBuffer = 500n;
  const totalFee = estimatedFee + feeBuffer;

  // Dust limit for Taproot outputs
  const DUST_LIMIT = 330n;

  // Total required = inscription amount + total fee + buffer for change
  const totalRequired = MIN_INSCRIPTION_AMOUNT + totalFee + DUST_LIMIT + 200n;

  console.log(`Estimated transaction size: ${txWeight.vbytes} vbytes`);
  console.log(`Transaction weight: ${txWeight.weightUnits.toLocaleString()} WU`);
  console.log(`Fee rate: ${feeRate} sat/vB`);
  console.log(`Estimated fee: ${estimatedFee} sats`);
  console.log(`Fee buffer: ${feeBuffer} sats`);
  console.log(`Total fee: ${totalFee} sats`);
  console.log(`Dust limit: ${DUST_LIMIT} sats`);
  console.log(`Total required: ${totalRequired} sats\n`);

  // Step 6: Wait for payment
  const utxo = await waitForPayment(inscriptionData.address, totalRequired);

  // Step 7: Confirm and create transaction
  const proceed = await confirm({
    message: "Proceed with creating the inscription?",
    default: true,
  });

  if (!proceed) {
    console.log("Cancelled.");
    process.exit(0);
  }

  // Step 8: Create and broadcast transaction
  console.log("\nCreating inscription transaction...");
  const txid = await createInscriptionTx(
    inscriptionData,
    utxo,
    totalRequired,
    recipientAddress
  );

  console.log("\n" + "=".repeat(60));
  console.log("INSCRIPTION COMPLETE!");
  console.log("=".repeat(60));
  console.log(`\nTransaction ID: ${txid}`);
  console.log(`Recipient: ${recipientAddress}`);
  console.log(`Inscription Amount: ${MIN_INSCRIPTION_AMOUNT} sats`);
  console.log(`\nYour inscription will be confirmed in the next block!\n`);
}

// Run the main function
main().catch((error) => {
  console.error("\nError:", error.message);
  process.exit(1);
});
