/**
 * @fileoverview Converts a witness stack to script witness format
 *
 * You can find the original implementation in bitcoinjs-lib:
 *
 * Old implementation:
 * @see {@link https://github.com/bitcoinjs/bitcoinjs-lib/blob/f67aab371c1d47684b3c211643a39e8e0295b306/ts_src/psbt.ts#L1418-L1446}
 *
 * New implementation:
 * @see {@link https://github.com/bitcoinjs/bitcoinjs-lib/blob/e4280e2767d9c7ab1b0a2d60e71bdc8751bbd9e9/ts_src/psbt/psbtutils.ts#L38-L66}
 *
 * To understand why we didn't just import it from bitcoinjs-lib, see:
 * @see {@link https://github.com/bitcoinjs/bitcoinjs-lib/issues/1862}
 */

/**
 * Encodes a number as a Bitcoin varint
 * @param number - Number to encode
 * @param buffer - Buffer to write to
 * @param offset - Offset in buffer
 * @returns Number of bytes written
 */
function varuintEncode(number: number, buffer: Buffer, offset: number): number {
  if (number < 0xfd) {
    buffer.writeUInt8(number, offset);
    return 1;
  } else if (number <= 0xffff) {
    buffer.writeUInt8(0xfd, offset);
    buffer.writeUInt16LE(number, offset + 1);
    return 3;
  } else if (number <= 0xffffffff) {
    buffer.writeUInt8(0xfe, offset);
    buffer.writeUInt32LE(number, offset + 1);
    return 5;
  } else {
    buffer.writeUInt8(0xff, offset);
    buffer.writeUInt32LE(number >>> 0, offset + 1);
    buffer.writeUInt32LE((number / 0x100000000) | 0, offset + 5);
    return 9;
  }
}

/**
 * Gets the encoding length for a varint
 * @param number - Number to check
 * @returns Number of bytes needed to encode
 */
function varuintEncodingLength(number: number): number {
  return number < 0xfd ? 1 : number <= 0xffff ? 3 : number <= 0xffffffff ? 5 : 9;
}

/**
 * Converts a witness stack to script witness format
 * @param witness - Array of witness buffers
 * @returns Encoded witness script buffer
 */
export function witnessStackToScriptWitness(witness: Buffer[]): Buffer {
  let buffer = Buffer.allocUnsafe(0);

  /**
   * Writes a slice to the buffer
   * @param slice - Buffer slice to write
   */
  function writeSlice(slice: Buffer): void {
    buffer = Buffer.concat([buffer, Buffer.from(slice)]);
  }

  /**
   * Writes a varint to the buffer
   * @param i - Number to write as varint
   */
  function writeVarInt(i: number): void {
    const currentLen = buffer.length;
    const varintLen = varuintEncodingLength(i);

    buffer = Buffer.concat([buffer, Buffer.allocUnsafe(varintLen)]);
    varuintEncode(i, buffer, currentLen);
  }

  /**
   * Writes a variable-length slice to the buffer
   * @param slice - Buffer slice to write with length prefix
   */
  function writeVarSlice(slice: Buffer): void {
    writeVarInt(slice.length);
    writeSlice(slice);
  }

  /**
   * Writes a vector of slices to the buffer
   * @param vector - Array of buffer slices
   */
  function writeVector(vector: Buffer[]): void {
    writeVarInt(vector.length);
    vector.forEach(writeVarSlice);
  }

  writeVector(witness);

  return buffer;
}
