import * as bitcoin from "bitcoinjs-lib";
import { breakContentIntoChunks } from "./misc.js";
import { witnessStackToScriptWitness } from "./witnessStackToScriptWitness.js";

import type { BIP32Interface } from "bip32";

/**
 * Converts a public key to x-only format (32 bytes)
 * @param pubkey - Public key buffer (33 or 32 bytes)
 * @returns X-only public key (32 bytes)
 */
export function toXOnly(pubkey: Uint8Array | Buffer): Uint8Array {
  return pubkey.length === 32 ? pubkey : pubkey.slice(1, 33);
}

/**
 * Derives a BIP32 path from a given root and index
 * @param root - BIP32 root key
 * @param index - Derivation index
 * @returns Derived BIP32 key pair
 * @throws {Error} If index is negative
 */
export function derivePathFromIndex(root: BIP32Interface, index: number): BIP32Interface {
  if (index < 0) throw new Error("invalid index");
  const derivePath = `m/84'/2'/0'/0/${index}`;
  return root.derivePath(derivePath);
}

/**
 * Makes an RPC call to Bitcoin Core
 * @param endpoint - RPC endpoint URL
 * @param user - RPC username for authentication
 * @param password - RPC password for authentication
 * @param method - RPC method name
 * @param params - RPC method parameters
 * @returns RPC response result
 */
export async function rpcCall(
  endpoint: string,
  user: string,
  password: string,
  method: string,
  params: any[] = []
): Promise<any> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(`${user}:${password}`).toString("base64"),
    },
    body: JSON.stringify({
      jsonrpc: "1.0",
      id: "inscribe-bitcoin-tx",
      method,
      params,
    }),
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(`RPC Error: ${data.error.message}`);
  }

  return data.result;
}

/**
 * Factory that returns a Taproot script-path custom finalizer.
 *
 * @param tapscript - Compiled Taproot script (Buffer)
 * @param controlBlock - Taproot control block (Buffer)
 * @returns custom finalizer function
 */
export function makeTaprootFinalizer(
  tapscript: Buffer | Uint8Array<ArrayBufferLike>,
  controlBlock: Uint8Array<ArrayBufferLike>
) {
  return function customFinalizer(
    _inputIndex: number,
    input: any
  ): { finalScriptWitness: Buffer } {
    if (!input.tapScriptSig?.[0]?.signature) {
      throw new Error("Missing tapScriptSig.signature");
    }

    // The three witness items
    const signature = input.tapScriptSig[0].signature;

    const witness = [
      signature, // #1 signature
      tapscript, // #2 tapscript
      controlBlock, // #3 control block
    ];

    return {
      finalScriptWitness: witnessStackToScriptWitness(witness),
    };
  };
}

export /**
 * Generate the tapscript for inscription
 * @param tweakKey The tweak key that is used to unlock the tapscript
 * @param content The content buffer to be inscribed
 * @param contentType The MIME type of content to be inscribed
 * @param metadata Optional metadata (as hex string)
 * @param parentID Optional parent inscription ID
 * @param brotliCompress If the content needs to be compressed (adds encoding tag)
 */
function generateTapscriptChunks(
  tweakKey: any,
  content: Buffer,
  contentType: string,
  metadata?: string,
  parentID?: string,
  brotliCompress: boolean = false
): any[] {
  const contentHex = content.toString("hex");

  // Generate Tapscript
  const tapscriptChunks: any[] = [
    Buffer.from(bitcoin.toXOnly(tweakKey.publicKey)),
    bitcoin.opcodes.OP_CHECKSIG,
    bitcoin.opcodes.OP_0,
    bitcoin.opcodes.OP_IF,
    Buffer.from("ord", "utf8"),
    1, // OP_PUSH 1 byte
    1, // Content type tag
    Buffer.from(contentType, "utf8"),
  ];

  // Add brotli compression encoding if needed
  //   if (brotliCompress) {
  //     tapscriptChunks.push(1); // OP_PUSH 1 byte
  //     tapscriptChunks.push(9); // Encoding tag
  //     tapscriptChunks.push(Buffer.from("br", "utf8"));
  //   }

  // Add parent ID if provided
  //   if (parentID) {
  //     tapscriptChunks.push(1); // OP_PUSH 1 byte
  //     tapscriptChunks.push(3); // Parent tag
  //     tapscriptChunks.push(Buffer.from(reverseBytes(parentID), "hex"));
  //   }

  // Add metadata if provided
  //   if (metadata) {
  //     tapscriptChunks.push(1); // OP_PUSH 1 byte
  //     tapscriptChunks.push(5); // Metadata tag
  //     tapscriptChunks.push(Buffer.from(metadata, "hex"));
  //   }

  // Add content body tag
  tapscriptChunks.push(bitcoin.opcodes.OP_0);

  // Break content into chunks to respect 520-byte push limit
  const contentChunks = breakContentIntoChunks(contentHex);

  console.log(`Content broken into ${contentChunks.length} chunk(s)`);

  // Add each content chunk to the script
  for (const chunk of contentChunks) {
    tapscriptChunks.push(Buffer.from(chunk, "hex"));
  }

  tapscriptChunks.push(bitcoin.opcodes.OP_ENDIF);

  return tapscriptChunks;
}

/**
 * Estimate transaction weight units and size
 */
export function estimateTxWeight(contentSize: number): {
  vbytes: number;
  weightUnits: number;
  exceedsLimit: boolean;
} {
  // Base transaction overhead (inputs, outputs, etc.)
  const baseTxSize = 10; // version, locktime, input/output counts

  // Input size (non-witness)
  const inputBaseSize = 41; // 36 (outpoint) + 1 (script length) + 4 (sequence)

  // Output sizes (non-witness)
  const outputSize = 43; // 8 (value) + 1 (script length) + 34 (P2TR scriptPubKey)
  const numOutputs = 2; // recipient + change (worst case)

  // Total base (non-witness) size
  const baseSize = baseTxSize + inputBaseSize + outputSize * numOutputs;

  // Witness data for Taproot script path spend
  const controlBlockSize = 33; // Control block for single leaf
  const scriptSize = contentSize + 100; // Script overhead (opcodes, pubkey, etc.)
  const signatureSize = 64; // Schnorr signature

  // Total witness size
  const witnessSize = controlBlockSize + scriptSize + signatureSize + 10; // +10 for witness stack item lengths

  // Weight units = base_size * 4 + witness_size
  const weightUnits = baseSize * 4 + witnessSize;

  // Virtual bytes = weight_units / 4 (rounded up)
  const vbytes = Math.ceil(weightUnits / 4);

  // Standard transaction weight limit
  const MAX_WEIGHT_UNITS = 400_000;
  const exceedsLimit = weightUnits > MAX_WEIGHT_UNITS;

  return {
    vbytes,
    weightUnits,
    exceedsLimit,
  };
}
