// Browser WebRTC adapter: same three entry points as rtc.ts, on web globals.
const g = globalThis as any;

export function createPeerConnection(): any {
  return new g.RTCPeerConnection();
}

export async function getMicStream(): Promise<any> {
  return g.navigator.mediaDevices.getUserMedia({ audio: true });
}

/** Browsers need an <audio> element in the DOM to play the remote track.
 * iOS Safari/Chrome will not play a detached element and needs playsInline. */
export function attachRemoteAudio(pc: any): void {
  pc.ontrack = (e: any) => {
    const doc = g.document;
    let audio = doc?.getElementById("walkie-remote-audio");
    if (!audio) {
      audio = doc.createElement("audio");
      audio.id = "walkie-remote-audio";
      audio.autoplay = true;
      audio.setAttribute("playsinline", "true");
      audio.style.display = "none";
      doc.body.appendChild(audio);
    }
    audio.srcObject = e.streams[0];
    audio.play?.().catch(() => {});
  };
}
