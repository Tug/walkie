import { mediaDevices, MediaStream, RTCPeerConnection } from "react-native-webrtc";
import type { McpClient, McpTool } from "./mcp";

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
}

export async function startVoiceSession(
  serverUrl: string,
  token: string,
  mcp: McpClient,
  tools: McpTool[],
  cb: SessionCallbacks,
): Promise<VoiceSession> {
  cb.onStatus("Minting session key…");
  const sec = await fetch(`${serverUrl}/voice/secret`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!sec.ok) {
    const body = await sec.json().catch(() => ({ error: `secret endpoint: ${sec.status}` }));
    throw new Error(body.error || `secret endpoint: ${sec.status}`);
  }
  const { value: ephemeral, model } = await sec.json();

  cb.onStatus("Opening microphone…");
  const mic: MediaStream = await mediaDevices.getUserMedia({ audio: true });

  const pc = new RTCPeerConnection({});
  for (const track of mic.getTracks()) pc.addTrack(track, mic);
  // Remote audio plays automatically in react-native-webrtc once the track arrives.

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
      cb.onTranscriptDelta(ev.delta);
    }
    if (ev.type === "response.done") cb.onTurnDone();
    if (ev.type === "error") cb.onStatus(`Realtime error: ${ev.error?.message || "unknown"}`);
    if (ev.type === "response.output_item.done" && ev.item?.type === "function_call") {
      const { name, call_id } = ev.item;
      let args: object = {};
      try {
        args = JSON.parse(ev.item.arguments || "{}");
      } catch {}
      cb.onStatus(`Tool: ${name}…`);
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

  return {
    mute: (muted: boolean) => {
      for (const track of mic.getAudioTracks()) track.enabled = !muted;
    },
    hangup: () => {
      for (const track of mic.getTracks()) track.stop();
      pc.close();
    },
  };
}
