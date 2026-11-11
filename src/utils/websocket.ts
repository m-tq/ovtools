import * as crypto from 'crypto';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WebSocketConnection {
  sendText(text: string): void;
  onText(listener: (text: string) => void): void;
  onClose(listener: () => void): void;
  close(code?: number, reason?: string): void;
}

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): WebSocketConnection | null {
  const key = String(req.headers['sec-websocket-key'] || '');
  const version = String(req.headers['sec-websocket-version'] || '');
  if (!key || version !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  let closed = false;
  let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  const textListeners: Array<(text: string) => void> = [];
  const closeListeners: Array<() => void> = [];

  const finish = () => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) {
      try {
        listener();
      } catch {
        // ignore
      }
    }
  };

  const parse = () => {
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(1 << 20)) {
          connection.close(1009, 'message too large');
          return;
        }
        length = Number(big);
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + length) return;
      let mask: Buffer | null = null;
      if (masked) {
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      buffer = buffer.subarray(offset + length);

      if (opcode === 0x8) {
        try {
          socket.write(frame(0x8, Buffer.alloc(0)));
        } catch {
          // ignore
        }
        socket.end();
        finish();
        return;
      }
      if (opcode === 0x9) {
        try {
          socket.write(frame(0xA, payload));
        } catch {
          // ignore
        }
        continue;
      }
      if (opcode === 0x1) {
        const text = payload.toString('utf8');
        for (const listener of textListeners) {
          try {
            listener(text);
          } catch {
            // ignore
          }
        }
      }
    }
  };

  const connection: WebSocketConnection = {
    sendText(text: string) {
      if (closed) return;
      try {
        socket.write(frame(0x1, Buffer.from(text, 'utf8')));
      } catch {
        finish();
      }
    },
    onText(listener) {
      textListeners.push(listener);
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
    close(code = 1000, reason = '') {
      if (closed) return;
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2, 'utf8');
      try {
        socket.write(frame(0x8, payload));
      } catch {
        // ignore
      }
      socket.end();
      finish();
    },
  };

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    parse();
  });
  socket.on('end', finish);
  socket.on('close', finish);
  socket.on('error', finish);
  parse();
  return connection;
}
