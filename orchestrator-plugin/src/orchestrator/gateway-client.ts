/**
 * Gateway WebSocket Client — 实现完整的 OpenClaw Gateway 协议。
 *
 * 协议流程（三次握手）：
 *   1. 建立 WebSocket 连接
 *   2. 收到 connect.challenge（nonce + ts）
 *   3. 发送 connect（auth token + device identity）
 *   4. 收到 hello-ok → 连接就绪
 *
 * 之后可以发送 agent.run 等 RPC 请求。
 */
import { randomUUID } from "node:crypto";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface PendingRequest {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  onFirstFrame?: (payload: JsonValue) => void;
  firstFrameReceived: boolean;
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestId = 0;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(
    private port: number,
    private token: string,
  ) {}

  async connect(): Promise<void> {
    if (this.connected) return;

    const deadline = Date.now() + 180_000;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt++;
      try {
        await this.tryConnect();
        return;
      } catch (err) {
        this.connectPromise = null;
        const msg = (err as Error).message;
        if (msg.includes("startup-sidecars") || msg.includes("timeout")) {
          if (attempt === 1) console.log("[gateway-client] waiting for Gateway startup...");
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        throw err;
      }
    }
    throw new Error("Gateway connect failed after 3 minutes");
  }

  private async tryConnect(): Promise<void> {
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const url = `ws://127.0.0.1:${this.port}`;
      console.log("[gateway-client] connecting to", url);
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log("[gateway-client] WS open, waiting for challenge...");
      };

      const timeout = setTimeout(() => {
        reject(new Error("Gateway connect timeout"));
      }, 3000);

      this.ws.onmessage = (event: MessageEvent) => {
        let msg: Record<string,unknown>;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          console.log("[gateway-client] non-JSON message, type:", typeof event.data,
            "preview:", String(event.data).slice(0, 100));
          return;
        }
        console.log("[gateway-client] recv:", JSON.stringify({
          type: msg.type,
          ok: msg.ok,
          event: (msg as Record<string,unknown>).event,
          error: (msg as Record<string,unknown>).error,
          payloadType: (msg.payload as Record<string,unknown>)?.type,
        }));

        // Handle challenge
        if (msg.type === "event" && msg.event === "connect.challenge") {
          const challenge = msg.payload as { nonce: string; ts: number };
          this.sendConnect(challenge);
          return;
        }

        // Handle hello-ok
        if (msg.type === "res" && msg.ok === true &&
            (msg.payload as Record<string,unknown>)?.type === "hello-ok") {
          clearTimeout(timeout);
          this.connected = true;
          console.log("[gateway-client] connected (hello-ok)");
          resolve();
          return;
        }

        // Handle error response
        if (msg.type === "res" && msg.ok === false) {
          const pending = this.pending.get(msg.id as string);
          if (pending) {
            this.pending.delete(msg.id as string);
            pending.reject(new Error(
              (msg.error as Record<string,string>)?.message ?? "gateway error"));
          }
          if (!this.connected) {
            clearTimeout(timeout);
            reject(new Error(`Connect failed: ${JSON.stringify(msg.error)}`));
          }
          return;
        }

        // Handle normal/dual-frame response
        if (msg.type === "res" && msg.ok === true) {
          const pending = this.pending.get(msg.id as string);
          if (!pending) return;

          const payload = msg.payload as JsonValue;
          const p = payload as Record<string,unknown> | undefined;

          // First frame of dual-frame response (agent.run ACK)
          if (!pending.firstFrameReceived && p?.["status"] === "accepted") {
            pending.firstFrameReceived = true;
            pending.onFirstFrame?.(payload);
            return; // Wait for second frame
          }

          // Second frame or single-frame response
          this.pending.delete(msg.id as string);
          pending.resolve(payload);
        }
      };

      this.ws.onerror = (err: Event) => {
        const msg = (err as ErrorEvent).message || "unknown";
        console.error("[gateway-client] WebSocket error:", msg);
        reject(new Error(`WebSocket error: ${msg}`));
      };

      this.ws.onclose = (event: CloseEvent) => {
        console.log(`[gateway-client] WS closed (code=${event.code})`);
        this.connected = false;
        this.ws = null;
        for (const [, p] of this.pending) p.reject(new Error("Gateway connection closed"));
        this.pending.clear();
      };
    });

    return this.connectPromise;
  }

  private sendConnect(challenge: { nonce: string; ts: number }): void {
    if (!this.ws) return;
    console.log("[gateway-client] sending connect (nonce=" + challenge.nonce.slice(0,8) + "...)");
    this.ws.send(JSON.stringify({
      type: "req",
      id: randomUUID(),
      method: "connect",
      params: {
        minProtocol: 4,
        maxProtocol: 4,
        client: {
          id: "gateway-client",
          version: "0.1.0",
          platform: process.platform,
          mode: "backend",
        },
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        auth: { token: this.token },
        locale: "en-US",
        userAgent: "openry-orchestrator-plugin/0.1.0",
      },
    }));
  }

  async call(
    method: string,
    params: Record<string, unknown>,
    opts?: { onFirstFrame?: (payload: JsonValue) => void },
  ): Promise<JsonValue> {
    if (!this.connected || !this.ws) {
      throw new Error("Gateway not connected");
    }

    const id = String(++this.requestId);
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        onFirstFrame: opts?.onFirstFrame,
        firstFrameReceived: false,
      });

      this.ws!.send(JSON.stringify({ type: "req", id, method, params }));

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Gateway RPC timeout (15min): ${method}`));
        }
      }, 900_000);
    });
  }

  /** Start an agent run and return the runId from the first ACK frame. */
  async runAgent(params: {
    message: string;
    sessionKey: string;
    agentId: string;
  }): Promise<string> {
    const idemKey = randomUUID();
    let runId = "";

    await this.call("agent", {
      message: params.message,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      idempotencyKey: idemKey,
    }, {
      onFirstFrame: (payload) => {
        runId = (payload as Record<string,unknown>)?.runId as string || idemKey;
      },
    });

    return runId || idemKey;
  }

  /** Abort a running agent session. */
  async abortRun(runId: string): Promise<void> {
    await this.call("chat.abort", { runId, idempotencyKey: randomUUID() });
  }

  isConnected(): boolean {
    return this.connected;
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }
}
