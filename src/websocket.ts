import * as crypto from 'crypto';

export function encodeMaskedWebSocketFrame(payload: Buffer, mask = crypto.randomBytes(4)): Buffer {
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x82, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x82;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const maskedPayload = Buffer.from(payload);
  for (let index = 0; index < maskedPayload.length; index++) {
    maskedPayload[index] ^= mask[index % 4];
  }
  return Buffer.concat([header, mask, maskedPayload]);
}
