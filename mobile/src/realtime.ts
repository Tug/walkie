import type { McpClient, McpTool } from "./mcp";
import { attachRemoteAudio, createPeerConnection, getMicStream } from "./rtc";

export const CONTROL_TOOLS = new Set(["spawn_worker", "send_to_agent", "reset_orchestrator"]);

export interface SessionCallbacks {
  onStatus: (message: string) => void;
  onTranscriptDelta: (delta: string) => void;
  onTurnDone: () => void;
  /** Resolve true to run the control-lane tool, false to deny. */
  onApproval: (name: string, args: object) => Promise<boolean>;
}

export interface VoiceSession {
  mute: (muted: boolean) => void;
  hangup: () => void;
  /** Send typed text into the conversation (model replies in audio as usual). */
  sendText: (text: string) => void;
  /** Send an image (data URL). Keep under ~200KB: data channel message limit. */
  sendImage: (dataUrl: string) => void;
}

export async function startVoiceSession(
  serverUrl: string,
  token: string,
  mcp: McpClient,
  tools: McpTool[],
  cb: SessionCallbacks,
  // Pass a pre-acquired mic stream when the platform requires getUserMedia to run
  // directly inside the user gesture (iOS Safari): acquire it first, connect after.
  preacquiredMic?: any,
): Promise<VoiceSession> {
  const logSession = `mobile-${Date.now().toString(36)}`;
  const log = (type: string, data: object = {}) => {
    fetch(`${serverUrl}/voice/log`, {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      body: JSON.stringify({ session: logSession, events: [{ type, ...data }] }),
    }).catch(() => {});
  };
  let turnText = "";

  cb.onStatus("Minting session key…");
  const sec = await fetch(`${serverUrl}/voice/secret`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!sec.ok) {
    const body = await sec.json().catch(() => ({ error: `secret endpoint: ${sec.status}` }));
    throw new Error(body.error || `secret endpoint: ${sec.status}`);
  }
  const { value: ephemeral, model } = await sec.json();

  cb.onStatus("Opening microphone…");
  const mic = preacquiredMic ?? (await getMicStream());

  const pc = createPeerConnection();
  for (const track of mic.getTracks()) pc.addTrack(track, mic);
  attachRemoteAudio(pc);

  const dc = pc.createDataChannel("oai-events");
  // react-native-webrtc's RTCDataChannel extends event-target-shim, whose typings
  // don't surface addEventListener through this tsconfig; runtime API is standard.
  const channel = dc as unknown as {
    addEventListener: (type: string, listener: (e: any) => void) => void;
    send: (data: string) => void;
  };

  channel.addEventListener("open", () => {
    channel.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          tools: tools.map((t) => ({
            type: "function",
            name: t.name,
            description: t.description || t.title || t.name,
            parameters: t.inputSchema,
          })),
        },
      }),
    );
    cb.onStatus("Live. Say something.");
  });

  channel.addEventListener("message", async (e: any) => {
    const ev = JSON.parse(e.data);
    if (ev.type === "response.output_audio_transcript.delta" || ev.type === "response.audio_transcript.delta") {
      turnText += ev.delta;
      cb.onTranscriptDelta(ev.delta);
    }
    if (ev.type === "response.done") {
      if (turnText) log("assistant_turn", { text: turnText });
      turnText = "";
      cb.onTurnDone();
    }
    if (ev.type === "error") {
      log("realtime_error", { error: ev.error });
      cb.onStatus(`Realtime error: ${ev.error?.message || "unknown"}`);
    }
    if (ev.type === "response.output_item.done" && ev.item?.type === "function_call") {
      const { name, call_id } = ev.item;
      let args: object = {};
      try {
        args = JSON.parse(ev.item.arguments || "{}");
      } catch {}
      cb.onStatus(`Tool: ${name}…`);
      log("tool_call", { name, args });
      let output: string;
      if (CONTROL_TOOLS.has(name) && !(await cb.onApproval(name, args))) {
        output = "The user denied this action.";
      } else {
        try {
          output = await mcp.call(name, args);
        } catch (err: any) {
          output = `Tool failed: ${err.message}`;
        }
      }
      log("tool_result", { name, output: output.slice(0, 2000) });
      channel.send(
        JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id, output } }),
      );
      channel.send(JSON.stringify({ type: "response.create" }));
      cb.onStatus("Live.");
    }
  });

  const offer = await pc.createOffer({});
  await pc.setLocalDescription(offer);
  const sdp = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ephemeral}`, "Content-Type": "application/sdp" },
    body: offer.sdp,
  });
  if (!sdp.ok) throw new Error(`Realtime SDP exchange failed: ${sdp.status}`);
  await pc.setRemoteDescription({ type: "answer", sdp: await sdp.text() });
  log("session_started", { model, tools: tools.map((t) => t.name) });

  return {
    mute: (muted: boolean) => {
      for (const track of mic.getAudioTracks()) track.enabled = !muted;
    },
    hangup: () => {
      log("session_ended");
      for (const track of mic.getTracks()) track.stop();
      pc.close();
    },
    sendText: (text: string) => {
      log("user_text", { text });
      channel.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
        }),
      );
      channel.send(JSON.stringify({ type: "response.create" }));
    },
    sendImage: (dataUrl: string) => {
      log("user_image", { bytes: dataUrl.length });
      channel.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_image", image_url: dataUrl }] },
        }),
      );
      channel.send(JSON.stringify({ type: "response.create" }));
    },
  };
}
