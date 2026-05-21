const assert = require('node:assert/strict');
const test = require('node:test');

const { encodeMaskedWebSocketFrame } = require('../dist/websocket.js');

function decodeMaskedFrame(frame) {
  let length = frame[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = frame.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    length = Number(frame.readBigUInt64BE(2));
    offset = 10;
  }
  const mask = frame.subarray(offset, offset + 4);
  const payload = Buffer.from(frame.subarray(offset + 4, offset + 4 + length));
  for (let index = 0; index < payload.length; index++) {
    payload[index] ^= mask[index % 4];
  }
  return {
    opcode: frame[0] & 0x0f,
    masked: (frame[1] & 0x80) !== 0,
    payload,
  };
}

test('client websocket frame masks short binary payloads', () => {
  const payload = Buffer.from('hello');
  const frame = encodeMaskedWebSocketFrame(payload, Buffer.from([1, 2, 3, 4]));
  assert.equal(frame[0], 0x82);
  assert.equal(frame[1], 0x80 | payload.length);
  const decoded = decodeMaskedFrame(frame);
  assert.equal(decoded.opcode, 0x2);
  assert.equal(decoded.masked, true);
  assert.deepEqual(decoded.payload, payload);
});

test('client websocket frame supports 16-bit extended payload length', () => {
  const payload = Buffer.alloc(130, 7);
  const frame = encodeMaskedWebSocketFrame(payload, Buffer.from([4, 3, 2, 1]));
  assert.equal(frame[1], 0x80 | 126);
  assert.equal(frame.readUInt16BE(2), payload.length);
  assert.deepEqual(decodeMaskedFrame(frame).payload, payload);
});
